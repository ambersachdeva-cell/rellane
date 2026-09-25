/** The bridge accepts owner rulings only from a trusted, stable window. */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GovernedProjectMemoryConflictView } from "@cadrane/contracts";
import { MIGRATIONS } from "../book/schema.js";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { saveWorkstationProject } from "./projects.js";
import {
  approvedProjectConstraints,
  projectMemoryEpoch,
  proposeProjectMemory,
  reviewProjectMemory
} from "./project-memory-book.js";
import { installProjectMemoryConflicts } from "./project-memory-conflict-ipc.js";

type Handler = (event: unknown, input: unknown) => Promise<GovernedProjectMemoryConflictView>;
const handlers = new Map<string, Handler>();
let ownerToken: object = {};
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) }
}));
vi.mock("../agents/source-owner.js", () => ({
  createAgentSourceOwners: () => () => ownerToken
}));

function book(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  return db;
}

function approve(db: DatabaseSync, projectId: string, text: string) {
  const proposed = proposeProjectMemory(db, {
    projectId, kind: "instruction", text, actorId: "trusted-owner"
  });
  return reviewProjectMemory(db, {
    projectId, id: proposed.id, expectedRevision: proposed.revision,
    decision: "approve", actorId: "trusted-owner"
  });
}

describe("governed conflict bridge", () => {
  beforeEach(() => {
    handlers.clear();
    ownerToken = { window: "one" };
  });

  it("lists, declares and resolves with a main-process actor and explainable authority", async () => {
    const db = book();
    try {
      const project = saveWorkstationProject(db, { title: "Style", brief: "Brief" });
      const a = approve(db, project.id, "Use a serif.");
      const b = approve(db, project.id, "Use a sans.");
      const beforeMutation = vi.fn();
      const assertTrusted = vi.fn();
      installProjectMemoryConflicts({
        assertTrusted, book: () => db,
        principalFor: () => "trusted-owner", beforeMutation
      });
      const invoke = handlers.get(IPC_CHANNELS.workstationMemoryConflicts)!;
      const event = { sender: {}, senderFrame: {} };
      const initial = await invoke(event, { action: "read", projectId: project.id });
      expect(initial.authority.status).toBe("ready");
      expect(initial.conflicts).toEqual([]);
      expect(beforeMutation).not.toHaveBeenCalled();

      const declared = await invoke(event, {
        action: "declare", projectId: project.id,
        firstMemoryId: a.id, secondMemoryId: b.id,
        expectedFirstActiveRevision: a.revision,
        expectedSecondActiveRevision: b.revision,
        expectedConflictRevision: 0,
        reason: "Both style rules cannot govern together."
      });
      expect(declared.epoch).toBe(initial.epoch + 1);
      expect(declared.authority).toMatchObject({ status: "blocked", reason: expect.stringMatching(/unresolved/u) });
      expect(declared.conflicts[0]?.history[0]).toMatchObject({
        state: "declared", actorId: "trusted-owner", reason: "Both style rules cannot govern together."
      });
      expect(beforeMutation).toHaveBeenCalledExactlyOnceWith(project.id);
      expect(() => approvedProjectConstraints(db, project.id)).toThrow(/unresolved/u);

      const conflict = declared.conflicts[0]!;
      const revisions = new Map([[a.id, a.revision], [b.id, b.revision]]);
      const resolved = await invoke(event, {
        action: "resolve", projectId: project.id,
        conflictId: conflict.id, expectedRevision: conflict.headRevision,
        expectedFirstActiveRevision: revisions.get(conflict.firstMemoryId),
        expectedSecondActiveRevision: revisions.get(conflict.secondMemoryId),
        resolution: { kind: "winner", winnerId: a.id },
        reason: "Owner chooses the serif."
      });
      expect(resolved.epoch).toBe(declared.epoch + 1);
      expect(resolved.authority).toMatchObject({
        status: "ready", included: [{ id: a.id }],
        excluded: [{ constraint: { id: b.id }, conflicts: [{
          conflictId: conflict.id, winnerId: a.id, reason: "Owner chooses the serif."
        }] }]
      });
      expect(resolved.conflicts[0]?.history[1]).toMatchObject({
        state: "resolved", actorId: "trusted-owner", resolution: expect.stringMatching(/wins/u)
      });
      expect(beforeMutation).toHaveBeenCalledTimes(2);
      expect(assertTrusted).toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("rejects actor injection, malformed nested commands and stale CAS before mutation", async () => {
    const db = book();
    try {
      const project = saveWorkstationProject(db, { title: "Style", brief: "Brief" });
      const a = approve(db, project.id, "Use a serif.");
      const b = approve(db, project.id, "Use a sans.");
      const beforeMutation = vi.fn();
      installProjectMemoryConflicts({
        assertTrusted: () => {}, book: () => db,
        principalFor: () => "trusted-owner", beforeMutation
      });
      const invoke = handlers.get(IPC_CHANNELS.workstationMemoryConflicts)!;
      const event = { sender: {}, senderFrame: {} };
      const declaration = {
        action: "declare", projectId: project.id,
        firstMemoryId: a.id, secondMemoryId: b.id,
        expectedFirstActiveRevision: a.revision,
        expectedSecondActiveRevision: b.revision,
        expectedConflictRevision: 0, reason: "Conflict"
      };
      await expect(invoke(event, { ...declaration, actorId: "renderer" })).rejects.toThrow();
      await expect(invoke(event, { ...declaration, reason: " ".repeat(5_001) })).rejects.toThrow();
      expect(beforeMutation).not.toHaveBeenCalled();
      const declared = await invoke(event, declaration);
      const epoch = projectMemoryEpoch(db, project.id);
      await expect(invoke(event, declaration)).rejects.toThrow(/Stale conflict revision/u);
      await expect(invoke(event, {
        action: "resolve", projectId: project.id,
        conflictId: declared.conflicts[0]!.id, expectedRevision: 1,
        expectedFirstActiveRevision: a.revision,
        expectedSecondActiveRevision: b.revision,
        resolution: { kind: "both_retired", actorId: "renderer" }, reason: "No winner"
      })).rejects.toThrow();
      expect(projectMemoryEpoch(db, project.id)).toBe(epoch);
    } finally {
      db.close();
    }
  });

  it("refuses untrusted or switched windows and a failed project gate without a write", async () => {
    const db = book();
    try {
      const project = saveWorkstationProject(db, { title: "Style", brief: "Brief" });
      const a = approve(db, project.id, "Use a serif.");
      const b = approve(db, project.id, "Use a sans.");
      const command = {
        action: "declare", projectId: project.id,
        firstMemoryId: a.id, secondMemoryId: b.id,
        expectedFirstActiveRevision: a.revision,
        expectedSecondActiveRevision: b.revision,
        expectedConflictRevision: 0, reason: "Conflict"
      };
      const event = { sender: {}, senderFrame: {} };
      installProjectMemoryConflicts({
        assertTrusted: () => { throw new Error("Untrusted caller"); },
        book: () => db, principalFor: () => "trusted-owner", beforeMutation: () => {}
      });
      let invoke = handlers.get(IPC_CHANNELS.workstationMemoryConflicts)!;
      await expect(invoke(event, command)).rejects.toThrow(/Untrusted caller/u);

      installProjectMemoryConflicts({
        assertTrusted: () => {}, book: () => db,
        principalFor: () => "trusted-owner",
        beforeMutation: () => { throw new Error("Project is active"); }
      });
      invoke = handlers.get(IPC_CHANNELS.workstationMemoryConflicts)!;
      await expect(invoke(event, command)).rejects.toThrow(/Project is active/u);

      installProjectMemoryConflicts({
        assertTrusted: () => {}, book: () => db,
        principalFor: () => { ownerToken = { window: "two" }; return "trusted-owner"; },
        beforeMutation: () => {}
      });
      invoke = handlers.get(IPC_CHANNELS.workstationMemoryConflicts)!;
      await expect(invoke(event, command)).rejects.toThrow(/window changed/u);
      expect(projectMemoryEpoch(db, project.id)).toBe(4);
    } finally {
      db.close();
    }
  });
});
