import type { IpcMainInvokeEvent } from "electron";
import { app, ipcMain } from "electron";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  WORKSTATION_CITATION_DRAFT_LIMIT,
  WORKSTATION_CITATION_SOURCES_TEXT_LIMIT,
  WorkstationCheckCitationsInputSchema
} from "@cadrane/contracts";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import { readCase, turnsFor } from "../book/cases.js";
import { CASE_SOURCE_SEAT_PREFIX } from "../../shared/case-sources.js";
import { checkHermesCitations, type HermesCitationsRuntimeOptions } from "./hermes-citations.js";

/**
 * Where the pinned checker actually lives, dev and packaged.
 *
 * Exported because the workstation host now reaches the same checker from a
 * tool call as well as from this channel, and two copies of this resolution
 * would eventually disagree — with the packaged build being the one that
 * silently picked up a development path. Lazy on purpose: `app.isPackaged` and
 * `process.resourcesPath` are only meaningful once Electron is ready.
 */
export function defaultHermesCitationsRuntimeOptions(): HermesCitationsRuntimeOptions {
  return {
    upstreamScriptsDir: app.isPackaged
      ? path.join(process.resourcesPath, "hermes-citations", "scripts")
      : path.resolve(app.getAppPath(), "../../vendor/hermes-agent/skills/research/grounded-citations/scripts"),
    bridgeScriptPath: app.isPackaged
      ? path.join(process.resourcesPath, "hermes-citations", "hermes-citations-bridge.py")
      : path.join(app.getAppPath(), "scripts/hermes-citations-bridge.py")
  };
}

export function installWorkstationCitations(options: {
  readonly book: () => DatabaseSync;
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly assertIdle: (caseId: string) => void;
  readonly runtimeOptions?: HermesCitationsRuntimeOptions;
}): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);
  let inFlight = false;
  const runtimeOptions = (): HermesCitationsRuntimeOptions =>
    options.runtimeOptions ?? defaultHermesCitationsRuntimeOptions();

  ipcMain.handle(IPC_CHANNELS.workstationCheckCitations, async (event, input: unknown) => {
    options.assertTrusted(event);
    const owner = ownerFor(event);

    if (inFlight) {
      throw new Error("A citation check is already running. Wait for it to finish.");
    }

    const request = WorkstationCheckCitationsInputSchema.parse(input);

    options.assertIdle(request.caseId);
    const workCase = readCase(options.book(), request.caseId);
    if (!workCase || workCase.closedAt !== null) {
      throw new Error("This work is closed. Open it before checking citations.");
    }

    if (Buffer.byteLength(request.draft, "utf8") > WORKSTATION_CITATION_DRAFT_LIMIT) {
      throw new Error(`Draft exceeds ${WORKSTATION_CITATION_DRAFT_LIMIT} byte limit.`);
    }

    const allTurns = turnsFor(options.book(), request.caseId);
    const turnsById = new Map(allTurns.map((t) => [t.id, t]));

    const selectedTurns: { sourceTurnId: string; label: string; body: string }[] = [];
    let totalSourcesBytes = 0;

    for (const id of request.sourceTurnIds) {
      const turn = turnsById.get(id);
      if (!turn) {
        throw new Error(`Selected source turn ${id} was not found in this work.`);
      }
      if (turn.kind !== "verbatim") {
        throw new Error(`Turn ${id} is not a verbatim source turn.`);
      }
      totalSourcesBytes += Buffer.byteLength(turn.body, "utf8");

      const rawLabel = turn.seat.startsWith(CASE_SOURCE_SEAT_PREFIX)
        ? turn.seat.slice(CASE_SOURCE_SEAT_PREFIX.length)
        : turn.seat === "owner"
          ? "Your notes"
          : turn.seat;
      // The checker's result schema bounds every string it will hand back.
      const label = rawLabel.slice(0, 200);

      selectedTurns.push({
        sourceTurnId: turn.id,
        label,
        body: turn.body
      });
    }

    if (totalSourcesBytes > WORKSTATION_CITATION_SOURCES_TEXT_LIMIT) {
      throw new Error(`Selected sources exceed ${WORKSTATION_CITATION_SOURCES_TEXT_LIMIT} byte limit.`);
    }

    inFlight = true;
    try {
      const result = await checkHermesCitations({
        caseId: request.caseId,
        draft: request.draft,
        sources: selectedTurns,
        runtimeOptions: runtimeOptions()
      });

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while checking citations.");
      }

      return result;
    } finally {
      inFlight = false;
    }
  });
}
