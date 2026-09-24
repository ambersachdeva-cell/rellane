import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import { readCase } from "../book/cases.js";
import {
  searchBook,
  type SearchOutcome,
  type SearchableTurn
} from "./book-search.js";

export const WORKSTATION_BOOK_SEARCH_QUERY_LIMIT = 4000;

export const WorkstationBookSearchInputSchema = z.union([
  z.string().max(WORKSTATION_BOOK_SEARCH_QUERY_LIMIT),
  z.object({
    query: z.string().max(WORKSTATION_BOOK_SEARCH_QUERY_LIMIT)
  })
]);

export interface InstallWorkstationBookSearchOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly book: () => DatabaseSync;
  readonly allTurns: (db: DatabaseSync) => readonly {
    readonly id: string;
    readonly caseId: string;
    readonly caseTitle: string;
    readonly seat: string;
    readonly kind: string;
    readonly body: string;
    readonly at: number;
  }[];
}

const EMPTY_OUTCOME: SearchOutcome = {
  hits: [],
  scanned: 0,
  matched: 0,
  summary: "0 matches across 0 pieces of work."
};

const UNAVAILABLE_OUTCOME: SearchOutcome = {
  hits: [],
  scanned: 0,
  matched: 0,
  summary: "The book is not open yet."
};

export function installWorkstationBookSearch(
  options: InstallWorkstationBookSearchOptions
): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) =>
    owners(event.sender, event.senderFrame);
  let inFlight: Promise<SearchOutcome> | null = null;

  ipcMain.handle(
    IPC_CHANNELS.workstationBookSearch,
    async (event, input: unknown): Promise<SearchOutcome> => {
      // Untrusted callers must be refused before any work or payload reading.
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const parsed = WorkstationBookSearchInputSchema.parse(input);
      const query = typeof parsed === "string" ? parsed : parsed.query;
      const trimmed = query.trim();

      // Avoid reading the entire notebook when there is nothing to search for.
      if (trimmed.length === 0) {
        options.assertTrusted(event);
        if (ownerFor(event) !== owner) {
          throw new Error("This window changed while searching.");
        }
        return EMPTY_OUTCOME;
      }

      // Fast typing produces keystroke events, not independent search requests;
      // joining the active in-flight search avoids queuing redundant work and error toasts.
      if (inFlight !== null) {
        const result = await inFlight;
        options.assertTrusted(event);
        if (ownerFor(event) !== owner) {
          throw new Error("This window changed while searching.");
        }
        return result;
      }

      const performSearch = async (): Promise<SearchOutcome> => {
        // Yield to allow concurrent invocations in the same event tick to join inFlight.
        await Promise.resolve();
        try {
          const db = options.book();
          const turns = options.allTurns(db);

          // Turns belonging to closed or deleted cases must never surface in search,
          // as the owner should only see and search active, open work.
          const openCaseIds = new Map<string, boolean>();
          const visibleTurns: SearchableTurn[] = [];

          for (let i = 0; i < turns.length; i++) {
            const turn = turns[i];
            if (turn === undefined) continue;

            let isOpen = openCaseIds.get(turn.caseId);
            if (isOpen === undefined) {
              try {
                const workCase = readCase(db, turn.caseId);
                isOpen = Boolean(workCase && workCase.closedAt === null);
              } catch {
                isOpen = false;
              }
              openCaseIds.set(turn.caseId, isOpen);
            }

            if (isOpen) {
              visibleTurns.push(turn);
            }
          }

          return searchBook(visibleTurns, trimmed);
        } catch {
          // Failure to open or read the book returns an empty outcome rather than
          // crashing, ensuring startup and window responsiveness remain unblocked.
          return UNAVAILABLE_OUTCOME;
        }
      };

      const task = performSearch();
      inFlight = task;
      try {
        const result = await task;
        options.assertTrusted(event);
        if (ownerFor(event) !== owner) {
          throw new Error("This window changed while searching.");
        }
        return result;
      } finally {
        inFlight = null;
      }
    }
  );
}
