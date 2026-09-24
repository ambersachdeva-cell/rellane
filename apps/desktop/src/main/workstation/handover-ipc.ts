import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { CASE_SOURCE_SEAT_PREFIX } from "../../shared/case-sources.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import { readCase as defaultReadCase, turnsFor as defaultTurnsFor } from "../book/cases.js";
import { buildAuditDocument, type TrailTurn } from "./audit-export.js";
import { planDeliveryPack, type PackInput } from "./delivery-pack.js";

const WorkstationAuditExportInputSchema = z.object({
  caseId: z.string().trim().min(1).max(128)
});

const WorkstationDeliveryPackInputSchema = z.object({
  caseId: z.string().trim().min(1).max(128),
  clientName: z.string().trim().max(128).nullable().optional(),
  confirm: z.boolean().optional().default(false),
  plan: z.unknown().optional()
});

export interface WorkstationHandoverOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly book: () => DatabaseSync;
  readonly readCase?: (
    db: DatabaseSync,
    caseId: string
  ) => { readonly id: string; readonly title: string; readonly closedAt: number | null } | null;
  readonly turnsFor?: (
    db: DatabaseSync,
    caseId: string
  ) => readonly { readonly id: string; readonly seat: string; readonly kind: string; readonly body: string; readonly at: number }[];
  /**
   * Where the pack lands. The case is named because a delivery belongs beside
   * the rest of that case's files, not in one shared heap whose folder names
   * are the only thing keeping two clients' packs apart.
   */
  readonly writeFolder: (
    caseId: string,
    folderName: string,
    files: readonly { readonly relativePath: string; readonly contents: string }[]
  ) => Promise<string>;
}

function extractSources(turns: readonly TrailTurn[]): PackInput["sources"] {
  const sources: { id: string; label: string; bytes: number; internal: boolean }[] = [];
  for (const turn of turns) {
    const rawKind = turn.kind.trim().toLowerCase();
    const rawSeat = turn.seat.trim().toLowerCase();

    const isSourceKind =
      rawKind === "verbatim" ||
      rawKind === "source" ||
      rawKind.startsWith("source") ||
      rawKind === "internal" ||
      rawKind.startsWith("internal");

    const isSourceSeat =
      turn.seat.startsWith(CASE_SOURCE_SEAT_PREFIX) ||
      rawSeat.startsWith("source") ||
      rawSeat.startsWith("internal") ||
      rawSeat === "owner" ||
      rawSeat === "you";

    if (isSourceKind || isSourceSeat) {
      let label = turn.seat;
      if (turn.seat.startsWith(CASE_SOURCE_SEAT_PREFIX)) {
        label = turn.seat.slice(CASE_SOURCE_SEAT_PREFIX.length);
      } else if (rawSeat.startsWith("source · ") || rawSeat.startsWith("source - ")) {
        label = turn.seat.slice(9);
      } else if (rawSeat.startsWith("internal · ") || rawSeat.startsWith("internal - ")) {
        label = turn.seat.slice(11);
      } else if (rawSeat === "owner" || rawSeat === "you") {
        label = "Your notes";
      }
      label = label.trim().slice(0, 200);
      if (label.length === 0) {
        label = "Source";
      }

      // Internal sources and owner notes must be marked internal so delivery-pack strictly excludes them.
      const internal =
        rawKind.includes("internal") ||
        rawSeat.includes("internal") ||
        rawSeat === "owner" ||
        rawSeat === "you" ||
        rawKind.includes("note") ||
        rawSeat.includes("note");

      sources.push({
        id: turn.id,
        label,
        bytes: Buffer.byteLength(turn.body, "utf8"),
        internal
      });
    }
  }
  return sources;
}

function extractOutputs(turns: readonly TrailTurn[]): PackInput["outputs"] {
  const candidateOutputs: { id: string; title: string; body: string; revision: number; isExplicit: boolean }[] = [];
  for (const turn of turns) {
    const rawKind = turn.kind.trim().toLowerCase();
    const rawSeat = turn.seat.trim().toLowerCase();

    if (
      rawKind === "verbatim" ||
      rawKind === "receipt" ||
      rawKind === "decision" ||
      rawKind === "permission" ||
      rawKind === "approval" ||
      rawKind === "prompt" ||
      rawKind === "request" ||
      rawKind === "ask" ||
      rawKind === "question" ||
      rawSeat === "owner" ||
      rawSeat === "you" ||
      rawSeat === "user"
    ) {
      continue;
    }

    const isExplicit =
      rawKind === "output" ||
      rawKind === "deliverable" ||
      rawKind === "document" ||
      rawSeat.startsWith("output") ||
      rawSeat.startsWith("deliverable");

    const isModelResponse =
      rawKind === "response" ||
      rawKind === "reply" ||
      rawKind === "answer" ||
      rawKind === "completion";

    if (isExplicit || isModelResponse) {
      let title = "";
      let body = turn.body;
      let revision = 1;

      if (turn.body.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(turn.body) as Record<string, unknown>;
          if (parsed && typeof parsed === "object") {
            if (typeof parsed["title"] === "string") title = parsed["title"];
            if (typeof parsed["body"] === "string") body = parsed["body"];
            if (typeof parsed["revision"] === "number") revision = parsed["revision"];
          }
        } catch {
          // Plain body text is not JSON
        }
      }

      if (!title) {
        if (turn.seat.startsWith("Output · ") || turn.seat.startsWith("Output - ")) {
          title = turn.seat.slice(9).trim();
        } else if (turn.seat.startsWith("Deliverable · ") || turn.seat.startsWith("Deliverable - ")) {
          title = turn.seat.slice(14).trim();
        } else {
          const lines = turn.body.split("\n");
          const firstLine = lines.length > 0 ? lines[0]!.trim() : "";
          if (firstLine.startsWith("# ")) {
            title = firstLine.slice(2).trim();
          } else {
            title = turn.seat.trim() || "Document";
          }
        }
      }

      candidateOutputs.push({
        id: turn.id,
        title,
        body,
        revision,
        isExplicit
      });
    }
  }

  const explicit = candidateOutputs.filter((o) => o.isExplicit);
  const selected = explicit.length > 0 ? explicit : candidateOutputs;
  return selected.map((o) => ({
    id: o.id,
    title: o.title,
    body: o.body,
    revision: o.revision
  }));
}

function extractImages(turns: readonly TrailTurn[]): PackInput["images"] {
  const images: { id: string; label: string; bytes: number }[] = [];
  for (const turn of turns) {
    const rawKind = turn.kind.trim().toLowerCase();
    const rawSeat = turn.seat.trim().toLowerCase();
    if (rawKind === "image" || rawKind === "photo" || rawSeat.startsWith("image")) {
      let label = turn.seat;
      if (turn.seat.startsWith("Image · ") || turn.seat.startsWith("Image - ")) {
        label = turn.seat.slice(8).trim();
      }
      images.push({
        id: turn.id,
        label: label || "Image",
        bytes: Buffer.byteLength(turn.body, "utf8")
      });
    }
  }
  return images;
}

export function installWorkstationHandover(options: WorkstationHandoverOptions): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);
  const readCase = options.readCase ?? defaultReadCase;
  const turnsFor = options.turnsFor ?? defaultTurnsFor;

  let inFlight = false;

  ipcMain.handle(IPC_CHANNELS.workstationAuditExport, async (event, input: unknown) => {
    options.assertTrusted(event);
    const owner = ownerFor(event);

    if (inFlight) {
      throw new Error("A handover operation is already in progress. Wait for it to finish.");
    }

    const request = WorkstationAuditExportInputSchema.parse(input);

    const workCase = readCase(options.book(), request.caseId);
    if (!workCase) {
      throw new Error("This work was not found.");
    }
    if (workCase.closedAt !== null) {
      throw new Error("This work is closed. Open it before exporting.");
    }

    const allTurns = turnsFor(options.book(), request.caseId);

    inFlight = true;
    try {
      const document = buildAuditDocument(workCase.title, allTurns);

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while exporting the record.");
      }

      return document;
    } catch (err) {
      if (err instanceof Error && (/[/\\]/.test(err.message) || /[a-zA-Z]:/.test(err.message))) {
        throw new Error("Handover operation failed.");
      }
      throw err;
    } finally {
      inFlight = false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.workstationDeliveryPack, async (event, input: unknown) => {
    options.assertTrusted(event);
    const owner = ownerFor(event);

    if (inFlight) {
      throw new Error("A handover operation is already in progress. Wait for it to finish.");
    }

    const request = WorkstationDeliveryPackInputSchema.parse(input);

    const workCase = readCase(options.book(), request.caseId);
    if (!workCase) {
      throw new Error("This work was not found.");
    }
    if (workCase.closedAt !== null) {
      throw new Error("This work is closed. Open it before preparing a delivery pack.");
    }

    const allTurns = turnsFor(options.book(), request.caseId);

    const sources = extractSources(allTurns);
    const outputs = extractOutputs(allTurns);
    const images = extractImages(allTurns);

    /**
     * The record that goes to a client is built from a redacted trail.
     *
     * The pack excludes internal sources as files, and a test caught the hole
     * that leaves: the audit record is built from every turn, so an internal
     * note the owner deliberately kept back was being shipped inside it. Two
     * routes into the pack meant the exclusion only guarded one of them.
     *
     * There is one route now. The full record is still available on its own
     * channel — that one is for the owner, and it is not what gets sent.
     */
    const internalTurnIds = new Set(
      sources.filter((source) => source.internal).map((source) => source.id)
    );
    const clientTrail = allTurns.filter((turn) => !internalTurnIds.has(turn.id));
    const auditDoc = buildAuditDocument(workCase.title, clientTrail);

    const clientName = request.clientName?.trim() ? request.clientName.trim() : null;

    const packInput: PackInput = {
      workTitle: workCase.title,
      clientName,
      at: Date.now(),
      outputs,
      sources,
      images,
      recordMarkdown: auditDoc.markdown
    };

    const plan = planDeliveryPack(packInput);

    if (!request.confirm) {
      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while planning the delivery pack.");
      }
      return plan;
    }

    inFlight = true;
    try {
      const files: { readonly relativePath: string; readonly contents: string }[] = [];

      files.push({
        relativePath: "README.md",
        contents: plan.readme
      });

      const turnMap = new Map(allTurns.map((t) => [t.id, t]));
      const outputsByTitle = new Map(outputs.map((o) => [o.title, o]));
      const imagesByLabel = new Map(images.map((img) => [img.label, img]));

      // Only items accepted by planDeliveryPack enter the files list. Internal sources are never reached.
      for (const item of plan.items) {
        if (item.kind === "record") {
          files.push({
            relativePath: item.relativePath,
            contents: auditDoc.markdown
          });
        } else if (item.kind === "source") {
          const sourceTurn = item.sourceId ? turnMap.get(item.sourceId) : undefined;
          const contents = sourceTurn ? sourceTurn.body : "";
          files.push({
            relativePath: item.relativePath,
            contents
          });
        } else if (item.kind === "output") {
          const out = outputsByTitle.get(item.title);
          const contents = out ? out.body : "";
          files.push({
            relativePath: item.relativePath,
            contents
          });
        } else if (item.kind === "image") {
          const img = imagesByLabel.get(item.title);
          const turn = img ? turnMap.get(img.id) : undefined;
          const contents = turn ? turn.body : "";
          files.push({
            relativePath: item.relativePath,
            contents
          });
        }
      }

      let folderPath: string;
      try {
        folderPath = await options.writeFolder(request.caseId, plan.folderName, files);
      } catch {
        throw new Error("Could not write the delivery pack folder.");
      }

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while preparing the delivery pack.");
      }

      // One shape, whether or not it was written. The plan is the answer; the
      // folder is an extra fact about it once it exists. Two shapes for one
      // question is how a caller ends up reading `plan.items` off a wrapper.
      return { ...plan, writtenTo: folderPath };
    } catch (err) {
      if (err instanceof Error && (/[/\\]/.test(err.message) || /[a-zA-Z]:/.test(err.message))) {
        throw new Error("Could not write the delivery pack folder.");
      }
      throw err;
    } finally {
      inFlight = false;
    }
  });
}
