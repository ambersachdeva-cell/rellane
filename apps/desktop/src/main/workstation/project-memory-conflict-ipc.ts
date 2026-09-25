/** Trusted owner bridge for explicit project-memory contradiction rulings. */
import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import type { DatabaseSync } from "node:sqlite";
import {
  GovernedProjectMemoryConflictCommandSchema,
  type GovernedProjectMemoryConflictView
} from "@cadrane/contracts";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import { explainApprovedProjectConstraints, projectMemoryEpoch } from "./project-memory-book.js";
import {
  declareProjectMemoryConflict,
  listProjectMemoryConflicts,
  resolveProjectMemoryConflict
} from "./project-memory-conflict-store.js";

export interface InstallProjectMemoryConflictsOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly book: () => DatabaseSync;
  readonly principalFor: (event: IpcMainInvokeEvent) => string;
  /** Refuses a live project run and invalidates pending reviews. */
  readonly beforeMutation: (projectId: string) => void;
}

function readView(db: DatabaseSync, projectId: string): GovernedProjectMemoryConflictView {
  const before = projectMemoryEpoch(db, projectId);
  const conflicts = listProjectMemoryConflicts(db, projectId);
  let authority: GovernedProjectMemoryConflictView["authority"];
  try {
    const selection = explainApprovedProjectConstraints(db, projectId);
    authority = { status: "ready", ...selection };
  } catch (error) {
    authority = {
      status: "blocked",
      reason: error instanceof Error ? error.message : "Project memory cannot be compiled. Review it again."
    };
  }
  const after = projectMemoryEpoch(db, projectId);
  if (after !== before) throw new Error("Project memory changed while reading conflict decisions. Review again.");
  return { projectId, epoch: after, conflicts, authority };
}

export function installProjectMemoryConflicts(options: InstallProjectMemoryConflictsOptions): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);

  ipcMain.handle(
    IPC_CHANNELS.workstationMemoryConflicts,
    async (event, input: unknown): Promise<GovernedProjectMemoryConflictView> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);
      const command = GovernedProjectMemoryConflictCommandSchema.parse(input);
      const principal = options.principalFor(event);
      if (typeof principal !== "string" || principal.trim().length === 0 || principal.length > 256) {
        throw new Error("A valid principal identity is required.");
      }
      const db = options.book();

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while accessing project memory.");
      }
      if (command.action === "read") {
        const view = readView(db, command.projectId);
        options.assertTrusted(event);
        if (ownerFor(event) !== owner) {
          throw new Error("This window changed while accessing project memory.");
        }
        return view;
      }

      options.beforeMutation(command.projectId);
      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while accessing project memory.");
      }
      if (command.action === "declare") {
        declareProjectMemoryConflict(db, {
          projectId: command.projectId,
          firstMemoryId: command.firstMemoryId,
          secondMemoryId: command.secondMemoryId,
          expectedFirstActiveRevision: command.expectedFirstActiveRevision,
          expectedSecondActiveRevision: command.expectedSecondActiveRevision,
          expectedConflictRevision: command.expectedConflictRevision,
          actorId: principal,
          reason: command.reason
        });
      } else {
        resolveProjectMemoryConflict(db, {
          projectId: command.projectId,
          conflictId: command.conflictId,
          expectedRevision: command.expectedRevision,
          expectedFirstActiveRevision: command.expectedFirstActiveRevision,
          expectedSecondActiveRevision: command.expectedSecondActiveRevision,
          resolution: command.resolution,
          actorId: principal,
          reason: command.reason
        });
      }
      const view = readView(db, command.projectId);
      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while accessing project memory.");
      }
      return view;
    }
  );
}
