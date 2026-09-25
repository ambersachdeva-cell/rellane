/** Accepted Compare work survives restart without replaying native children. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../book/schema.js";
import { openCase } from "../book/cases.js";
import { recoveredCompareBoard, saveCompareChild, saveCompareParent } from "./compare-run-store.js";

describe("Compare Book receipts", () => {
  it("distinguishes attempted and unstarted children after reopening the Book", () => {
    const folder = mkdtempSync(join(tmpdir(), "rellane-compare-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(file);
      db.exec("PRAGMA foreign_keys = ON");
      for (const migration of MIGRATIONS) db.exec(migration.sql);
      const caseId = openCase(db, { title: "Compare evidence", question: "Review the brief" });
      saveCompareParent(db, { event: "parent", runId, caseId, brief: "Review the brief", at: 100,
        children: [
          { providerId: "claude", label: "Claude", modelId: "sonnet", contextSnapshotId: "context-a", sourceHash: "hash-a" },
          { providerId: "codex", label: "Codex", modelId: "gpt-5-codex", contextSnapshotId: "context-b", sourceHash: "hash-b" }
        ] });
      saveCompareChild(db, caseId, { event: "child", runId, index: 0, state: "starting", at: 101,
        line: "Admission pending", answerTurnId: null, draftTurnId: null, chars: 0 });
      db.close(); db = new DatabaseSync(file);
      const interrupted = recoveredCompareBoard(db, runId)!;
      expect(interrupted.done).toBe(true);
      expect(interrupted.lanes.map((lane) => lane.state)).toEqual(["interrupted", "interrupted"]);
      expect(interrupted.lanes[0]?.line).toContain("attempted");
      expect(interrupted.lanes[1]?.line).toContain("not started");

      saveCompareChild(db, caseId, { event: "child", runId, index: 0, state: "answered", at: 102,
        line: "Answer received", answerTurnId: "turn-a", draftTurnId: null, chars: 12 });
      saveCompareChild(db, caseId, { event: "child", runId, index: 1, state: "stopped", at: 103,
        line: "Stopped before dispatch", answerTurnId: null, draftTurnId: null, chars: 0 });
      db.close(); db = new DatabaseSync(file);
      const settled = recoveredCompareBoard(db, runId)!;
      expect(settled.lanes.map((lane) => [lane.state, lane.answerTurnId])).toEqual([
        ["answered", "turn-a"], ["stopped", null]
      ]);
      expect(settled.answered).toBe(1);
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
