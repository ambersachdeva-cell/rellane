import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../book/schema.js";
import type { GovernedProjectMemoryView } from "@cadrane/contracts";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { installProjectMemory } from "./project-memory-ipc.js";
import { projectMemoryEpoch } from "./project-memory-book.js";

type IpcHandler = (event: unknown, input: unknown) => Promise<unknown>;
const registeredHandlers = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      registeredHandlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      registeredHandlers.delete(channel);
    })
  }
}));

let currentOwnerToken: object = { id: "owner-1" };
vi.mock("../agents/source-owner.js", () => ({
  createAgentSourceOwners: () => () => currentOwnerToken
}));

function createTestDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE workstation_project (
      id TEXT PRIMARY KEY,
      memory_epoch INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE workstation_project_memory_entry (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      head_revision INTEGER NOT NULL,
      active_revision INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES workstation_project(id)
    );

    CREATE TABLE workstation_project_memory_revision (
      entry_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      body TEXT NOT NULL,
      source_refs_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      approver_id TEXT,
      approved_at INTEGER,
      reason TEXT,
      PRIMARY KEY (entry_id, revision),
      FOREIGN KEY (entry_id) REFERENCES workstation_project_memory_entry(id)
    );

    CREATE TABLE workstation_project_link (
      case_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      PRIMARY KEY (case_id, project_id)
    );

    CREATE TABLE case_turn (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      body TEXT NOT NULL
    );

    CREATE TABLE workstation_context_snapshot (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      packet TEXT,
      manifest_json TEXT,
      redacted_at INTEGER
    );
    CREATE TABLE workstation_context_snapshot_constraint (
      snapshot_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, memory_id)
    );
  `);
  db.exec(MIGRATIONS.find((migration) => migration.version === 13)!.sql);
  db.exec(MIGRATIONS.find((migration) => migration.version === 14)!.sql);
  return db;
}

describe("project-memory-governed-ipc", () => {
  let tempRoot = "";
  let memoryFolder = "";
  let db: DatabaseSync;
  let beforeMutationCalls: string[] = [];
  let assertTrustedMock = vi.fn();
  let principalForMock = vi.fn(() => "trusted-test-principal");

  const mockEvent = { sender: {}, senderFrame: {} };

  beforeEach(async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rellane-govmem-test-"));
    memoryFolder = path.join(tempRoot, "memory");
    await fs.promises.mkdir(memoryFolder, { recursive: true });

    registeredHandlers.clear();
    beforeMutationCalls = [];
    currentOwnerToken = { id: "owner-1" };
    assertTrustedMock = vi.fn();
    principalForMock = vi.fn(() => "trusted-test-principal");

    db = createTestDatabase();
    db.prepare("INSERT INTO workstation_project (id, memory_epoch) VALUES (?, 0)").run("proj-alpha");
  });

  afterEach(async () => {
    registeredHandlers.clear();
    try {
      db.close();
    } catch {}
    if (tempRoot.length > 0) {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  function setupInstalled() {
    installProjectMemory({
      assertTrusted: assertTrustedMock,
      folder: () => memoryFolder,
      book: () => db,
      principalFor: principalForMock,
      beforeMutation: (projectId: string) => {
        beforeMutationCalls.push(projectId);
      }
    });
  }

  it("enforces trusted scope and rejects untrusted callers", async () => {
    assertTrustedMock.mockImplementation(() => {
      throw new Error("Untrusted transport caller.");
    });
    setupInstalled();

    const handler = registeredHandlers.get(IPC_CHANNELS.workstationMemoryGoverned);
    expect(handler).toBeDefined();

    await expect(
      handler!(mockEvent, { action: "read", projectId: "proj-alpha" })
    ).rejects.toThrow("Untrusted transport caller.");
  });

  it("strictly rejects client actor injection via schema", async () => {
    setupInstalled();
    const handler = registeredHandlers.get(IPC_CHANNELS.workstationMemoryGoverned)!;

    await expect(
      handler(mockEvent, {
        action: "propose",
        projectId: "proj-alpha",
        kind: "instruction",
        text: "Attempt actor injection",
        actorId: "malicious-client-actor"
      })
    ).rejects.toThrow();
  });

  it("executes beforeMutation callback and failure prevents database mutation and epoch increment", async () => {
    installProjectMemory({
      assertTrusted: assertTrustedMock,
      folder: () => memoryFolder,
      book: () => db,
      principalFor: principalForMock,
      beforeMutation: () => {
        throw new Error("Pre-mutation hook aborted.");
      }
    });
    const handler = registeredHandlers.get(IPC_CHANNELS.workstationMemoryGoverned)!;

    await expect(
      handler(mockEvent, {
        action: "propose",
        projectId: "proj-alpha",
        kind: "decision",
        text: "This should never land in database"
      })
    ).rejects.toThrow("Pre-mutation hook aborted.");

    expect(projectMemoryEpoch(db, "proj-alpha")).toBe(0);
    const entries = db.prepare("SELECT count(*) AS count FROM workstation_project_memory_entry").get() as { count: number };
    expect(entries.count).toBe(0);
  });

  it("rechecks owner identity before mutation and rejects when window changes", async () => {
    installProjectMemory({
      assertTrusted: (event) => {
        assertTrustedMock(event);
        if (assertTrustedMock.mock.calls.length > 1) {
          currentOwnerToken = { id: "swapped-owner" };
        }
      },
      folder: () => memoryFolder,
      book: () => db,
      principalFor: principalForMock,
      beforeMutation: (projectId) => beforeMutationCalls.push(projectId)
    });
    const handler = registeredHandlers.get(IPC_CHANNELS.workstationMemoryGoverned)!;

    await expect(
      handler(mockEvent, {
        action: "propose",
        projectId: "proj-alpha",
        kind: "instruction",
        text: "Window swap during proposal"
      })
    ).rejects.toThrow("This window changed while accessing project memory.");

    expect(projectMemoryEpoch(db, "proj-alpha")).toBe(0);
  });

  it("enforces stale revision checks without incrementing epoch", async () => {
    setupInstalled();
    const handler = registeredHandlers.get(IPC_CHANNELS.workstationMemoryGoverned)!;

    const proposeResult = (await handler(mockEvent, {
      action: "propose",
      projectId: "proj-alpha",
      kind: "instruction",
      text: "Rule 1: Always check revisions"
    })) as GovernedProjectMemoryView;

    expect(proposeResult.epoch).toBe(1);
    const itemId = proposeResult.items[0]!.id;

    await expect(
      handler(mockEvent, {
        action: "review",
        projectId: "proj-alpha",
        id: itemId,
        expectedRevision: 99,
        decision: "approve"
      })
    ).rejects.toThrow(/Stale memory revision/);

    expect(projectMemoryEpoch(db, "proj-alpha")).toBe(1);

    await expect(
      handler(mockEvent, {
        action: "forget",
        projectId: "proj-alpha",
        id: itemId,
        expectedRevision: 99,
        reason: "Stale forget attempt"
      })
    ).rejects.toThrow(/Stale memory revision/);

    expect(projectMemoryEpoch(db, "proj-alpha")).toBe(1);
  });

  it("binds normalized finding role tags to trusted proposal and approval revisions", async () => {
    setupInstalled();
    const handler = registeredHandlers.get(IPC_CHANNELS.workstationMemoryGoverned)!;
    const invalid = {
      action: "propose", projectId: "proj-alpha", kind: "finding",
      text: "A project finding.", roleTags: ["Lead Analyst"]
    };
    await expect(handler(mockEvent, invalid)).rejects.toThrow();
    expect(projectMemoryEpoch(db, "proj-alpha")).toBe(0);

    const proposed = await handler(mockEvent, {
      ...invalid, roleTags: ["reviewer", "design"]
    }) as GovernedProjectMemoryView;
    const entry = proposed.items[0]!;
    expect(entry.candidate?.roleTags).toEqual(["design", "reviewer"]);
    expect(entry.candidate?.createdBy).toBe("trusted-test-principal");
    await expect(handler(mockEvent, {
      action: "review", projectId: "proj-alpha", id: entry.id,
      expectedRevision: entry.headRevision, decision: "approve"
    })).rejects.toThrow(/Confirm the finding's exact role tags/u);
    expect(projectMemoryEpoch(db, "proj-alpha")).toBe(1);
    const approved = await handler(mockEvent, {
      action: "review", projectId: "proj-alpha", id: entry.id,
      expectedRevision: entry.headRevision, decision: "approve", roleTags: ["design", "reviewer"]
    }) as GovernedProjectMemoryView;
    expect(approved.items[0]?.active?.roleTags).toEqual(["design", "reviewer"]);
    expect(approved.items[0]?.active?.approverId).toBe("trusted-test-principal");
    await expect(handler(mockEvent, {
      action: "propose", projectId: "proj-alpha", id: entry.id,
      expectedRevision: 1, kind: "finding", text: "A project finding.", roleTags: ["finance"]
    })).rejects.toThrow(/Stale memory revision/u);
    expect(projectMemoryEpoch(db, "proj-alpha")).toBe(2);
  });

  it("enforces missing/unknown project error", async () => {
    setupInstalled();
    const handler = registeredHandlers.get(IPC_CHANNELS.workstationMemoryGoverned)!;

    await expect(
      handler(mockEvent, {
        action: "read",
        projectId: "proj-nonexistent"
      })
    ).rejects.toThrow("Project 'proj-nonexistent' does not exist.");
  });

  it("completes full roundtrip proposal, review, list and forget lifecycle with verbatim text preservation", async () => {
    setupInstalled();
    const handler = registeredHandlers.get(IPC_CHANNELS.workstationMemoryGoverned)!;

    // Verify initial empty read
    const initialRead = (await handler(mockEvent, {
      action: "read",
      projectId: "proj-alpha"
    })) as GovernedProjectMemoryView;
    expect(initialRead.epoch).toBe(0);
    expect(initialRead.items).toHaveLength(0);

    // Setup link and case turn for source refs validation
    db.prepare("INSERT INTO workstation_project_link (case_id, project_id) VALUES (?, ?)").run("case-1", "proj-alpha");
    const turnText = "Source turn body from conversation";
    const turnHash = createHash("sha256").update(turnText, "utf8").digest("hex");
    db.prepare("INSERT INTO case_turn (id, case_id, body) VALUES (?, ?, ?)").run("turn-1", "case-1", turnText);

    const verbatimText = "  Never invoice without VAT number: GB-999-001  \n\tStrict terms.  ";

    // Step 1: Propose
    const proposedView = (await handler(mockEvent, {
      action: "propose",
      projectId: "proj-alpha",
      kind: "instruction",
      text: verbatimText,
      sourceRefs: [
        {
          caseId: "case-1",
          turnId: "turn-1",
          sha256: turnHash
        }
      ]
    })) as GovernedProjectMemoryView;

    expect(proposedView.epoch).toBe(1);
    expect(proposedView.items).toHaveLength(1);
    const item = proposedView.items[0]!;
    expect(item.kind).toBe("instruction");
    expect(item.activeRevision).toBeNull();
    expect(item.active).toBeNull();
    expect(item.candidate).toBeDefined();
    expect(item.candidate!.revision).toBe(1);
    expect(item.candidate!.state).toBe("proposed");
    expect(item.candidate!.text).toBe(verbatimText);
    expect(item.candidate!.createdBy).toBe("trusted-test-principal");
    expect(item.candidate!.sourceRefs).toHaveLength(1);
    expect(item.candidate!.sourceRefs[0]!.sha256).toBe(turnHash);
    expect(beforeMutationCalls).toEqual(["proj-alpha"]);

    // Step 2: Review (Approve)
    const approvedView = (await handler(mockEvent, {
      action: "review",
      projectId: "proj-alpha",
      id: item.id,
      expectedRevision: 1,
      decision: "approve",
      reason: "Approved during team review"
    })) as GovernedProjectMemoryView;

    expect(approvedView.epoch).toBe(2);
    const approvedItem = approvedView.items[0]!;
    expect(approvedItem.activeRevision).toBe(2);
    expect(approvedItem.active).toBeDefined();
    expect(approvedItem.active!.revision).toBe(2);
    expect(approvedItem.active!.state).toBe("approved");
    expect(approvedItem.active!.text).toBe(verbatimText);
    expect(approvedItem.active!.approverId).toBe("trusted-test-principal");
    expect(approvedItem.active!.reason).toBe("Approved during team review");
    expect(approvedItem.candidate).toBeNull();

    // Step 3: Read returns current authoritative state
    const readView = (await handler(mockEvent, {
      action: "read",
      projectId: "proj-alpha"
    })) as GovernedProjectMemoryView;
    expect(readView.epoch).toBe(2);
    expect(readView.items[0]!.activeRevision).toBe(2);

    // Step 4: Forget
    const forgottenView = (await handler(mockEvent, {
      action: "forget",
      projectId: "proj-alpha",
      id: item.id,
      expectedRevision: 2,
      reason: "Contract terms expired"
    })) as GovernedProjectMemoryView;

    expect(forgottenView.epoch).toBe(3);
    expect(forgottenView.items).toHaveLength(0);
  });

  it("retains legacy JSON methods and keeps canonical channel unavailable when optional config is omitted", async () => {
    installProjectMemory({
      assertTrusted: assertTrustedMock,
      folder: () => memoryFolder
    });

    expect(registeredHandlers.get(IPC_CHANNELS.workstationMemoryGoverned)).toBeUndefined();

    const legacyRead = registeredHandlers.get(IPC_CHANNELS.workstationMemoryRead);
    const legacyLearn = registeredHandlers.get(IPC_CHANNELS.workstationMemoryLearn);
    const legacySet = registeredHandlers.get(IPC_CHANNELS.workstationMemorySet);
    const legacyForget = registeredHandlers.get(IPC_CHANNELS.workstationMemoryForget);

    expect(legacyRead).toBeDefined();
    expect(legacyLearn).toBeDefined();
    expect(legacySet).toBeDefined();
    expect(legacyForget).toBeDefined();

    const res = (await legacyRead!(mockEvent, { projectId: "legacy-proj" })) as { facts: unknown[] };
    expect(res.facts).toEqual([]);
  });
});
