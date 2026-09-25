import { DatabaseSync } from "node:sqlite";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  appendTurn,
  closeCase,
  openCase
} from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import {
  acceptArtifact,
  saveArtifact,
  type ArtifactLineageEntry
} from "./artifacts.js";
import {
  installArtifactLineage,
  uninstallArtifactLineage
} from "./artifact-lineage-ipc.js";

type IpcHandler = (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>;

const handlers = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: IpcHandler) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    }
  }
}));

const trustedSender = {
  sender: { id: 1 },
  senderFrame: { processId: 1, routingId: 1 }
} as unknown as IpcMainInvokeEvent;

const untrustedSender = {
  sender: { id: 999 },
  senderFrame: { processId: 999, routingId: 999 }
} as unknown as IpcMainInvokeEvent;

function assertTrusted(event: IpcMainInvokeEvent): void {
  if (event !== trustedSender) {
    throw new Error("Untrusted sender rejected");
  }
}

async function invokeArtifactLineage(
  event: IpcMainInvokeEvent,
  input: unknown
): Promise<readonly ArtifactLineageEntry[]> {
  const handler = handlers.get(IPC_CHANNELS.casesArtifactLineage);
  if (!handler) {
    throw new Error("Handler for casesArtifactLineage is not registered");
  }
  return (await handler(event, input)) as readonly ArtifactLineageEntry[];
}

describe("artifactLineage IPC endpoint", () => {
  let db: DatabaseSync;
  let id: string;

  beforeEach(() => {
    handlers.clear();
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS) {
      db.exec(migration.sql);
    }
    id = openCase(db, { title: "Campaign", question: "Prepare a launch note" });
  });

  afterEach(() => {
    uninstallArtifactLineage();
    db.close();
  });

  it("rejects untrusted sender before database is accessed", async () => {
    let dbAccessed = false;
    const spyBook = (): DatabaseSync => {
      dbAccessed = true;
      return db;
    };

    installArtifactLineage({
      assertTrusted,
      book: spyBook
    });

    await expect(
      invokeArtifactLineage(untrustedSender, { caseId: id })
    ).rejects.toThrow("Untrusted sender rejected");

    expect(dbAccessed).toBe(false);
  });

  it("rejects malformed payloads with strict schema validation", async () => {
    installArtifactLineage({
      assertTrusted,
      book: () => db
    });

    await expect(invokeArtifactLineage(trustedSender, null)).rejects.toThrow();
    await expect(invokeArtifactLineage(trustedSender, undefined)).rejects.toThrow();
    await expect(invokeArtifactLineage(trustedSender, "plain-string")).rejects.toThrow();
    await expect(invokeArtifactLineage(trustedSender, {})).rejects.toThrow();
    await expect(invokeArtifactLineage(trustedSender, { caseId: "" })).rejects.toThrow();
    await expect(invokeArtifactLineage(trustedSender, { caseId: "   " })).rejects.toThrow();
    await expect(invokeArtifactLineage(trustedSender, { caseId: 42 })).rejects.toThrow();
    await expect(
      invokeArtifactLineage(trustedSender, { caseId: "x".repeat(300) })
    ).rejects.toThrow();
    await expect(
      invokeArtifactLineage(trustedSender, { caseId: id, extraField: "disallowed" })
    ).rejects.toThrow();
  });

  it("rejects non-existent case identifier before computing lineage", async () => {
    installArtifactLineage({
      assertTrusted,
      book: () => db
    });

    await expect(
      invokeArtifactLineage(trustedSender, { caseId: "non-existent-case-id" })
    ).rejects.toThrow(/Workroom not found/);
  });

  it("returns same-case ordered lineage and flags invalid stored source reference", async () => {
    installArtifactLineage({
      assertTrusted,
      book: () => db
    });

    const sourceTurn = appendTurn(db, id, {
      seat: "Local · researcher",
      kind: "verbatim",
      body: "Initial research draft"
    });

    const v1 = saveArtifact(db, {
      id,
      body: "First version body",
      baseVersionId: null,
      sourceTurnId: sourceTurn
    });
    acceptArtifact(db, id, v1.id);

    const v2 = saveArtifact(db, {
      id,
      body: "Second version body",
      baseVersionId: v1.id,
      sourceTurnId: null
    });

    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      `INSERT INTO case_artifact_version (id, case_id, revision, source_turn_id, body, created_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("corrupt-source-v3", id, 3, "ghost-turn-404", "Third version body", Date.now(), null);
    db.exec("PRAGMA foreign_keys = ON");

    const lineage = await invokeArtifactLineage(trustedSender, { caseId: id });
    expect(lineage).toHaveLength(3);

    const entry3 = lineage[0]!;
    const entry2 = lineage[1]!;
    const entry1 = lineage[2]!;

    expect(entry3.revision).toBe(3);
    expect(entry3.versionId).toBe("corrupt-source-v3");
    expect(entry3.status).toBe("unverified");
    expect(entry3.sourceTurnId).toBe("ghost-turn-404");
    expect(entry3.source).toBeNull();
    expect(entry3.sourceSeat).toBeNull();
    expect(entry3.sourceKind).toBeNull();
    expect(entry3.reason).toContain("ghost-turn-404");
    expect(entry3.reason).toContain("not found in this workroom");
    expect(entry3).not.toHaveProperty("body");

    expect(entry2.revision).toBe(2);
    expect(entry2.versionId).toBe(v2.id);
    expect(entry2.previousVersionId).toBe(v1.id);
    expect(entry2.sourceTurnId).toBeNull();
    expect(entry2.source).toBeNull();
    expect(entry2.status).toBe("verified");
    expect(entry2.reason).toBeNull();
    expect(entry2.acceptedAt).toBeNull();
    expect(entry2).not.toHaveProperty("body");

    expect(entry1.revision).toBe(1);
    expect(entry1.versionId).toBe(v1.id);
    expect(entry1.previousVersionId).toBeNull();
    expect(entry1.sourceTurnId).toBe(sourceTurn);
    expect(entry1.sourceSeat).toBe("Local · researcher");
    expect(entry1.sourceKind).toBe("verbatim");
    expect(entry1.source).toEqual({
      id: sourceTurn,
      seat: "Local · researcher",
      kind: "verbatim"
    });
    expect(entry1.status).toBe("verified");
    expect(entry1.reason).toBeNull();
    expect(entry1.acceptedAt).not.toBeNull();
    expect(entry1).not.toHaveProperty("body");
  });

  it("enforces cross-case isolation and protects foreign sources from leakage", async () => {
    installArtifactLineage({
      assertTrusted,
      book: () => db
    });

    const otherCaseId = openCase(db, {
      title: "Other Client",
      question: "Confidential inquiry"
    });

    const foreignTurnId = appendTurn(db, otherCaseId, {
      seat: "Secret · seat",
      kind: "verbatim",
      body: "TOP_SECRET_CROSS_CASE_PAYLOAD"
    });

    const foreignVersion = saveArtifact(db, {
      id: otherCaseId,
      body: "Other workroom content",
      baseVersionId: null,
      sourceTurnId: foreignTurnId
    });

    db.prepare(
      `INSERT INTO case_artifact_version (id, case_id, revision, source_turn_id, body, created_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("cross-case-v", id, 1, foreignTurnId, "Infiltrated artifact", Date.now(), null);

    const lineageCase1 = await invokeArtifactLineage(trustedSender, { caseId: id });
    expect(lineageCase1).toHaveLength(1);
    const entry = lineageCase1[0]!;

    expect(entry.id).toBe("cross-case-v");
    expect(entry.status).toBe("unverified");
    expect(entry.sourceTurnId).toBe(foreignTurnId);
    expect(entry.sourceSeat).toBeNull();
    expect(entry.sourceKind).toBeNull();
    expect(entry.source).toBeNull();
    expect(entry.reason).toContain(foreignTurnId);
    expect(entry.reason).toContain("not found in this workroom");

    const serialized = JSON.stringify(lineageCase1);
    expect(serialized).not.toContain("TOP_SECRET_CROSS_CASE_PAYLOAD");

    const lineageCase2 = await invokeArtifactLineage(trustedSender, { caseId: otherCaseId });
    expect(lineageCase2).toHaveLength(1);
    expect(lineageCase2[0]?.id).toBe(foreignVersion.id);
    expect(lineageCase2[0]?.status).toBe("verified");
    expect(lineageCase2[0]?.sourceTurnId).toBe(foreignTurnId);
    expect(lineageCase2[0]?.sourceSeat).toBe("Secret · seat");
  });

  it("permits historical lineage reads on closed cases without mutation", async () => {
    installArtifactLineage({
      assertTrusted,
      book: () => db
    });

    const sourceTurn = appendTurn(db, id, {
      seat: "Local · author",
      kind: "verbatim",
      body: "Final approved source text"
    });

    const version = saveArtifact(db, {
      id,
      body: "Final accepted output",
      baseVersionId: null,
      sourceTurnId: sourceTurn
    });
    acceptArtifact(db, id, version.id);

    const openLineage = await invokeArtifactLineage(trustedSender, { caseId: id });
    expect(openLineage).toHaveLength(1);
    expect(openLineage[0]?.status).toBe("verified");

    closeCase(db, id, { closedAs: "settled", verdict: "Delivered to client" });

    const closedLineage = await invokeArtifactLineage(trustedSender, { caseId: id });
    expect(closedLineage).toEqual(openLineage);
  });

  it("cleans up handler when uninstalled", async () => {
    const uninstall = installArtifactLineage({
      assertTrusted,
      book: () => db
    });

    expect(handlers.has(IPC_CHANNELS.casesArtifactLineage)).toBe(true);
    uninstall();
    expect(handlers.has(IPC_CHANNELS.casesArtifactLineage)).toBe(false);
  });
});
