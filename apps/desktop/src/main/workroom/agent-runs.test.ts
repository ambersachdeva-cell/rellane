import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRunResult } from "@cadrane/contracts";
import { MIGRATIONS } from "../book/schema.js";
import { allCases, closeCase, readCase, turnsFor } from "../book/cases.js";
import { artifactVersions, saveArtifact } from "./artifacts.js";
import { newBrief, resolveBrief, type Ceiling } from "../agents/brief.js";
import { finishAgentWorkroom, startAgentWorkroom } from "./agent-runs.js";

let db: DatabaseSync;
const brief = newBrief({ id: "reader", name: "Fictional reader", purpose: "Read the chosen note",
  instructions: "Keep negative facts explicit.", folders: ["/fictional"], capabilities: ["read_text"], tier: "on-device", outbound: "never" });
const ceiling: Ceiling = { grantedFolders: ["/fictional"], availableCapabilities: ["read_text"], storedAgents: [] };
const answered: AgentRunResult = { id: "actual-run", agentId: brief.id, agentName: brief.name,
  outcome: "answered", summary: "The agent returned a draft.", answer: "Artwork is NOT approved.",
  problem: null, substituted: null, ranOnLabel: "This Mac observed-model", read: ["read job.txt"], elapsedMs: 4000, approxTokens: 220 };
const start = () => startAgentWorkroom(db, brief, "  Check job.txt without sending anything.  ", resolveBrief(brief, ceiling));
beforeEach(() => {
  db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
});
afterEach(() => db.close());

describe("durable agent workrooms", () => {
  it("keeps an immutable brief/request and an interrupted-start explanation before any answer", () => {
    const room = start();
    const turns = turnsFor(db, room.caseId);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.body).toBe("  Check job.txt without sending anything.  ");
    expect(turns[1]?.kind).toBe("receipt");
    expect(turns[1]?.body).toContain("will not restart automatically");
    expect(turns[1]?.body).toContain('"instructions": "Keep negative facts explicit."');
    expect(turns[1]?.body).toContain('"allowedFolders": [\n    "/fictional"');
    expect(readCase(db, room.caseId)?.closedAt).toBeNull();
    expect(artifactVersions(db, room.caseId)).toEqual([]);
    const before = turnsFor(db, room.caseId);
    allCases(db); readCase(db, room.caseId); turnsFor(db, room.caseId);
    expect(turnsFor(db, room.caseId)).toEqual(before);
  });

  it("keeps an unaccepted answer and its read receipt together, usable by the existing output flow", () => {
    const room = start();
    finishAgentWorkroom(db, room, answered);
    const turns = turnsFor(db, room.caseId);
    expect(turns).toHaveLength(4);
    expect(turns[2]).toMatchObject({ kind: "verbatim", seat: "Agent · Fictional reader", body: answered.answer });
    expect(turns[3]?.body).toContain(`Agent run ${room.attemptId} finished — answered.`);
    expect(turns[3]?.body).toContain("read job.txt");
    expect(turns[3]?.body).toContain("This Mac observed-model");
    expect(turns[3]?.body).toContain("Nothing was automatically accepted");
    expect(artifactVersions(db, room.caseId)).toEqual([]);
    const version = saveArtifact(db, { id: room.caseId, body: answered.answer, sourceTurnId: turns[2]!.id, baseVersionId: null });
    expect(version.acceptedAt).toBeNull();
    expect(version.sourceTurnId).toBe(turns[2]!.id);
    expect(() => finishAgentWorkroom(db, room, answered)).toThrow("no longer matches");
    expect(readCase(db, room.caseId)?.closedAt).toBeNull();
  });

  it("rolls back a failed start entirely and a failed completion without leaving a stray answer", () => {
    db.exec("CREATE TEMP TRIGGER reject_start BEFORE INSERT ON case_turn WHEN NEW.seat='agent run' BEGIN SELECT RAISE(FAIL,'disk write refused'); END");
    expect(start).toThrow("disk write refused");
    expect(allCases(db)).toHaveLength(0);
    db.exec("DROP TRIGGER reject_start");
    const room = start();
    db.exec("CREATE TEMP TRIGGER reject_finish BEFORE INSERT ON case_turn WHEN NEW.body LIKE 'Agent run % finished %' BEGIN SELECT RAISE(FAIL,'disk write refused'); END");
    expect(() => finishAgentWorkroom(db, room, answered)).toThrow("disk write refused");
    expect(turnsFor(db, room.caseId)).toHaveLength(2);
    expect(turnsFor(db, room.caseId).some(turn => turn.body === answered.answer)).toBe(false);
    expect(artifactVersions(db, room.caseId)).toHaveLength(0);
  });

  it("records stopped/failed/refused attempts without accepting text or changing historical identity", () => {
    for (const outcome of ["stopped", "failed", "refused"] as const) {
      const room = start();
      const result = { ...answered, outcome, answer: "", problem: "This attempt did not finish." };
      expect(() => finishAgentWorkroom(db, room, { ...result, agentId: "replacement" })).toThrow("no longer matches");
      expect(() => finishAgentWorkroom(db, room, { ...result, agentName: "Renamed later" })).toThrow("no longer matches");
      finishAgentWorkroom(db, room, result);
      expect(turnsFor(db, room.caseId)).toHaveLength(3);
      expect(turnsFor(db, room.caseId)[2]?.body).toContain(`finished — ${outcome}`);
      expect(turnsFor(db, room.caseId)[2]?.body).toContain("No answer was accepted");
    }
    const room = start(); closeCase(db, room.caseId, { closedAs: "settled", verdict: "Closed by the person" });
    expect(() => finishAgentWorkroom(db, room, answered)).toThrow("no longer matches");
    expect(turnsFor(db, room.caseId)).toHaveLength(2);
  });
});
