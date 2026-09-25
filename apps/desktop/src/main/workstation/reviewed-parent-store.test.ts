/**
 * Verified durable receipts for reviewed parent runs and children.
 *
 * Exercises reopening SQLite files across runs, distinguishes unstarted from
 * attempted-starting children, validates draft/answer turn IDs, enforces strict
 * isolation against malformed rows, and checks kind/case boundaries and transaction rollbacks.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { appendTurn, openCase } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import {
  recoverReviewedParent,
  REVIEWED_PARENT_PREFIX,
  saveReviewedChild,
  saveReviewedParent,
  type ReviewedChildRecord,
  type ReviewedParentRecord
} from "./reviewed-parent-store.js";

function setupTestDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
  }
  return db;
}

function insertAnswerTurn(
  db: DatabaseSync,
  caseId: string,
  id: string,
  body = "Answer body",
  kind = "verbatim",
  at = 100
): void {
  db.prepare(
    `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
     VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), 'workstation', ?, ?, ?)`
  ).run(id, caseId, caseId, kind, body, at);
}

describe("Reviewed Parent Store", () => {
  it("reopens SQLite file and distinguishes completed first child from unstarted second", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, {
        title: "Agent Investigation",
        question: "Analyze recent bank statements"
      });

      const parentRecord: ReviewedParentRecord = {
        event: "parent",
        kind: "agent",
        runId,
        caseId,
        request: "Analyze recent bank statements",
        brief: "Statement brief",
        at: 100,
        children: [
          {
            id: "child-0",
            label: "Child A",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet",
            contextSnapshotId: "snap-a",
            sourceHash: "hash-a"
          },
          {
            id: "child-1",
            label: "Child B",
            providerId: "openai",
            modelId: "gpt-4o",
            contextSnapshotId: "snap-b",
            sourceHash: "hash-b"
          }
        ]
      };
      saveReviewedParent(db!, parentRecord);

      insertAnswerTurn(db, caseId, "turn-answer-0", "Statements validated successfully", "verbatim", 101);

      const answeredChild: ReviewedChildRecord = {
        event: "child",
        kind: "agent",
        runId,
        childId: "child-0",
        state: "answered",
        at: 102,
        line: "Statements validated successfully",
        answerTurnId: "turn-answer-0",
        draftTurnId: null,
        chars: 180
      };
      saveReviewedChild(db!, caseId, answeredChild);

      db.close();
      db = new DatabaseSync(file);

      const recovered = recoverReviewedParent(db!, "agent", runId);
      expect(recovered).not.toBeNull();
      expect(recovered?.runId).toBe(runId);
      expect(recovered?.kind).toBe("agent");
      expect(recovered?.caseId).toBe(caseId);
      expect(recovered?.done).toBe(false);
      expect(recovered?.status).toBe("interrupted");
      expect(recovered?.answeredCount).toBe(1);
      expect(recovered?.totalChildren).toBe(2);

      const [child0, child1] = recovered!.children;
      expect(child0?.id).toBe("child-0");
      expect(child0?.state).toBe("answered");
      expect(child0?.attempted).toBe(true);
      expect(child0?.answerTurnId).toBe("turn-answer-0");
      expect(child0?.draftTurnId).toBeNull();
      expect(child0?.line).toBe("Statements validated successfully");

      expect(child1?.id).toBe("child-1");
      expect(child1?.state).toBe("interrupted");
      expect(child1?.attempted).toBe(false);
      expect(child1?.answerTurnId).toBeNull();
      expect(child1?.draftTurnId).toBeNull();
      expect(child1?.line).toContain("not started");
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("recovers starting child as interrupted with attempted:true on lost acknowledgement", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, {
        title: "Research Run",
        question: "Investigate tax regulations"
      });

      const parentRecord: ReviewedParentRecord = {
        event: "parent",
        kind: "research",
        runId,
        caseId,
        request: "Investigate tax regulations",
        at: 200,
        children: [
          {
            id: "part-0",
            label: "Tax Analyst",
            providerId: "google",
            modelId: "gemini-2.5-pro",
            contextSnapshotId: "snap-tax",
            sourceHash: "hash-tax"
          }
        ]
      };
      saveReviewedParent(db!, parentRecord);

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "research",
        runId,
        childId: "part-0",
        state: "starting",
        at: 205,
        line: "Query sent to provider",
        answerTurnId: null,
        draftTurnId: null,
        chars: 0
      });

      db.close();
      db = new DatabaseSync(file);

      const recovered = recoverReviewedParent(db!, "research", runId);
      expect(recovered).not.toBeNull();
      expect(recovered?.done).toBe(false);
      expect(recovered?.status).toBe("interrupted");
      expect(recovered?.children[0]?.state).toBe("interrupted");
      expect(recovered?.children[0]?.attempted).toBe(true);
      expect(recovered?.children[0]?.answerTurnId).toBeNull();
      expect(recovered?.children[0]?.line).toContain("attempted");
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("truthfully preserves partial draftTurnId on stopped and answerTurnId on answered", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, {
        title: "Crew Synthesis",
        question: "Draft contract clause"
      });

      saveReviewedParent(db!, {
        event: "parent",
        kind: "crew",
        runId,
        caseId,
        request: "Draft contract clause",
        at: 300,
        children: [
          {
            id: "draft-worker",
            label: "Drafter",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet",
            contextSnapshotId: "snap-c1",
            sourceHash: "hash-c1",
            role: "Drafter",
            work: "Draft indemnity"
          },
          {
            id: "review-worker",
            label: "Reviewer",
            providerId: "openai",
            modelId: "gpt-4o",
            contextSnapshotId: "snap-c2",
            sourceHash: "hash-c2",
            dependsOn: ["draft-worker"],
            role: "Reviewer",
            work: "Check cross references"
          }
        ]
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "crew",
        runId,
        childId: "draft-worker",
        state: "stopped",
        at: 305,
        line: "Cancelled by user before final answer",
        answerTurnId: null,
        draftTurnId: "turn-draft-worker",
        chars: 75
      });

      insertAnswerTurn(db, caseId, "turn-answer-reviewer", "Review completed cleanly", "verbatim", 309);

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "crew",
        runId,
        childId: "review-worker",
        state: "answered",
        at: 310,
        line: "Review completed cleanly",
        answerTurnId: "turn-answer-reviewer",
        draftTurnId: null,
        chars: 312
      });

      db.close();
      db = new DatabaseSync(file);

      const recovered = recoverReviewedParent(db!, "crew", runId);
      expect(recovered).not.toBeNull();
      expect(recovered?.status).toBe("stopped");
      expect(recovered?.done).toBe(false);

      const draftChild = recovered?.children.find((c) => c.id === "draft-worker");
      const reviewChild = recovered?.children.find((c) => c.id === "review-worker");

      expect(draftChild?.state).toBe("stopped");
      expect(draftChild?.draftTurnId).toBe("turn-draft-worker");
      expect(draftChild?.answerTurnId).toBeNull();
      expect(draftChild?.attempted).toBe(false);

      expect(reviewChild?.state).toBe("answered");
      expect(reviewChild?.draftTurnId).toBeNull();
      expect(reviewChild?.answerTurnId).toBe("turn-answer-reviewer");
      expect(reviewChild?.attempted).toBe(true);
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("isolates malformed receipts without aborting valid recovery", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, {
        title: "Robustness check",
        question: "Ensure malformed receipts are skipped"
      });

      saveReviewedParent(db!, {
        event: "parent",
        kind: "agent",
        runId,
        caseId,
        request: "Tolerate unreadable rows",
        at: 400,
        children: [
          {
            id: "lane-1",
            label: "Lane 1",
            providerId: "anthropic",
            modelId: "sonnet",
            contextSnapshotId: "s1",
            sourceHash: "h1"
          },
          {
            id: "lane-2",
            label: "Lane 2",
            providerId: "google",
            modelId: "gemini",
            contextSnapshotId: "s2",
            sourceHash: "h2"
          }
        ]
      });

      appendTurn(
        db,
        caseId,
        {
          seat: "workstation",
          kind: "receipt",
          body: `${REVIEWED_PARENT_PREFIX}${runId}:{"event":"child","brokenJson":`
        },
        401
      );

      appendTurn(
        db,
        caseId,
        {
          seat: "workstation",
          kind: "receipt",
          body: `${REVIEWED_PARENT_PREFIX}${runId}:{"event":"child","kind":"agent","runId":"${runId}","state":"invalid-state"}`
        },
        402
      );

      insertAnswerTurn(db, caseId, "turn-answer-lane-1", "Lane 1 completed", "verbatim", 402);

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "lane-1",
        state: "answered",
        at: 403,
        line: "Lane 1 completed",
        answerTurnId: "turn-answer-lane-1",
        draftTurnId: null,
        chars: 140
      });

      insertAnswerTurn(db, caseId, "turn-answer-lane-2", "Lane 2 completed", "verbatim", 403);

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "lane-2",
        state: "answered",
        at: 404,
        line: "Lane 2 completed",
        answerTurnId: "turn-answer-lane-2",
        draftTurnId: null,
        chars: 220
      });

      const recovered = recoverReviewedParent(db!, "agent", runId);
      expect(recovered).not.toBeNull();
      expect(recovered?.done).toBe(true);
      expect(recovered?.status).toBe("done");
      expect(recovered?.answeredCount).toBe(2);
      expect(recovered?.children[0]?.state).toBe("answered");
      expect(recovered?.children[1]?.state).toBe("answered");
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("enforces kind, case, and run ID boundaries on save and recovery", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseA = openCase(db, { title: "Case A", question: "Question A" });
      const caseB = openCase(db, { title: "Case B", question: "Question B" });

      saveReviewedParent(db!, {
        event: "parent",
        kind: "agent",
        runId,
        caseId: caseA,
        request: "Boundaries inspection",
        at: 500,
        children: [
          {
            id: "worker-0",
            label: "Worker",
            providerId: "anthropic",
            modelId: "sonnet",
            contextSnapshotId: "s0",
            sourceHash: "h0"
          }
        ]
      });

      expect(recoverReviewedParent(db!, "crew", runId)).toBeNull();
      expect(recoverReviewedParent(db!, "research", runId)).toBeNull();
      expect(recoverReviewedParent(db!, "agent", randomUUID())).toBeNull();
      expect(recoverReviewedParent(db!, "agent", "invalid-uuid")).toBeNull();

      expect(() => {
        saveReviewedChild(db!, caseB, {
          event: "child",
          kind: "agent",
          runId,
          childId: "worker-0",
          state: "answered",
          at: 501,
          line: "Answer",
          answerTurnId: "t1",
          draftTurnId: null,
          chars: 10
        });
      }).toThrow(/does not match parent caseId/);

      expect(() => {
        saveReviewedChild(db!, caseA, {
          event: "child",
          kind: "crew",
          runId,
          childId: "worker-0",
          state: "answered",
          at: 502,
          line: "Answer",
          answerTurnId: "t1",
          draftTurnId: null,
          chars: 10
        });
      }).toThrow(/does not match parent kind/);

      expect(() => {
        saveReviewedChild(db!, caseA, {
          event: "child",
          kind: "agent",
          runId,
          childId: "nonexistent-worker",
          state: "answered",
          at: 503,
          line: "Answer",
          answerTurnId: "t1",
          draftTurnId: null,
          chars: 10
        });
      }).toThrow(/not found in parent children/);

      expect(() => {
        saveReviewedChild(db!, caseA, {
          event: "child",
          kind: "agent",
          runId: randomUUID(),
          childId: "worker-0",
          state: "answered",
          at: 504,
          line: "Answer",
          answerTurnId: "t1",
          draftTurnId: null,
          chars: 10
        });
      }).toThrow(/parent receipt for runId .* not found/);
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("refuses duplicate parent identity, duplicate child IDs, and dependency cycles", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, { title: "Uniqueness", question: "Validation check" });

      const parentRecord: ReviewedParentRecord = {
        event: "parent",
        kind: "crew",
        runId,
        caseId,
        request: "Check uniqueness",
        at: 600,
        children: [
          {
            id: "step-1",
            label: "Step 1",
            providerId: "anthropic",
            modelId: "sonnet",
            contextSnapshotId: "s1",
            sourceHash: "h1"
          },
          {
            id: "step-2",
            label: "Step 2",
            providerId: "openai",
            modelId: "gpt-4o",
            contextSnapshotId: "s2",
            sourceHash: "h2",
            dependsOn: ["step-1"]
          }
        ]
      };

      saveReviewedParent(db!, parentRecord);

      expect(() => {
        saveReviewedParent(db!, parentRecord);
      }).toThrow(/Duplicate parent receipt/);

      expect(() => {
        saveReviewedParent(db!, {
          ...parentRecord,
          runId: randomUUID(),
          children: [
            {
              id: "duplicate-id",
              label: "First",
              providerId: "anthropic",
              modelId: "sonnet",
              contextSnapshotId: "s1",
              sourceHash: "h1"
            },
            {
              id: "duplicate-id",
              label: "Second",
              providerId: "openai",
              modelId: "gpt-4o",
              contextSnapshotId: "s2",
              sourceHash: "h2"
            }
          ]
        });
      }).toThrow(/Duplicate child id/);

      expect(() => {
        saveReviewedParent(db!, {
          ...parentRecord,
          runId: randomUUID(),
          children: [
            {
              id: "self-dep",
              label: "Self Dep",
              providerId: "anthropic",
              modelId: "sonnet",
              contextSnapshotId: "s1",
              sourceHash: "h1",
              dependsOn: ["self-dep"]
            }
          ]
        });
      }).toThrow(/cannot depend on itself/);

      expect(() => {
        saveReviewedParent(db!, {
          ...parentRecord,
          runId: randomUUID(),
          children: [
            {
              id: "a",
              label: "A",
              providerId: "p",
              modelId: "m",
              contextSnapshotId: "s",
              sourceHash: "h",
              dependsOn: ["b"]
            },
            {
              id: "b",
              label: "B",
              providerId: "p",
              modelId: "m",
              contextSnapshotId: "s",
              sourceHash: "h",
              dependsOn: ["a"]
            }
          ]
        });
      }).toThrow(/Circular dependency/);
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("rolls back transactions atomically on failed parent or child writes", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, { title: "Rollback Test", question: "Atomicity check" });

      const initialTurnCount = Number(
        (
          db.prepare("SELECT COUNT(*) AS count FROM case_turn").get() as {
            readonly count: number;
          }
        ).count
      );

      expect(() => {
        saveReviewedParent(db!, {
          event: "parent",
          kind: "agent",
          runId,
          caseId: "nonexistent-case-id",
          request: "Should rollback",
          at: 700,
          children: [
            {
              id: "w1",
              label: "W1",
              providerId: "p",
              modelId: "m",
              contextSnapshotId: "s",
              sourceHash: "h"
            }
          ]
        });
      }).toThrow(/does not exist/);

      const turnCountAfterFailedParent = Number(
        (
          db.prepare("SELECT COUNT(*) AS count FROM case_turn").get() as {
            readonly count: number;
          }
        ).count
      );
      expect(turnCountAfterFailedParent).toBe(initialTurnCount);

      saveReviewedParent(db!, {
        event: "parent",
        kind: "agent",
        runId,
        caseId,
        request: "Legitimate parent",
        at: 701,
        children: [
          {
            id: "legit-child",
            label: "Legit",
            providerId: "p",
            modelId: "m",
            contextSnapshotId: "s",
            sourceHash: "h"
          }
        ]
      });

      const turnCountAfterValidParent = Number(
        (
          db.prepare("SELECT COUNT(*) AS count FROM case_turn").get() as {
            readonly count: number;
          }
        ).count
      );
      expect(turnCountAfterValidParent).toBe(initialTurnCount + 1);

      expect(() => {
        saveReviewedChild(db!, caseId, {
          event: "child",
          kind: "agent",
          runId,
          childId: "unknown-child-id",
          state: "answered",
          at: 702,
          line: "Should not persist",
          answerTurnId: "turn-bad",
          draftTurnId: null,
          chars: 50
        });
      }).toThrow(/not found in parent children/);

      const turnCountAfterFailedChild = Number(
        (
          db.prepare("SELECT COUNT(*) AS count FROM case_turn").get() as {
            readonly count: number;
          }
        ).count
      );
      expect(turnCountAfterFailedChild).toBe(turnCountAfterValidParent);
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("applies latest row order update to transition starting child to answered and settles run as done", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, {
        title: "Full Completion",
        question: "Validate terminal state transitions"
      });

      saveReviewedParent(db!, {
        event: "parent",
        kind: "agent",
        runId,
        caseId,
        request: "Transition test",
        at: 800,
        children: [
          {
            id: "child-worker",
            label: "Worker",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet",
            contextSnapshotId: "snap-w",
            sourceHash: "hash-w"
          }
        ]
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "child-worker",
        state: "starting",
        at: 801,
        line: "Starting work",
        answerTurnId: null,
        draftTurnId: null,
        chars: 0
      });

      const interim = recoverReviewedParent(db!, "agent", runId);
      expect(interim?.done).toBe(false);
      expect(interim?.status).toBe("interrupted");
      expect(interim?.children[0]?.state).toBe("interrupted");
      expect(interim?.children[0]?.attempted).toBe(true);

      insertAnswerTurn(db, caseId, "turn-answer-completed", "Answer arrived", "verbatim", 801);

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "child-worker",
        state: "answered",
        at: 802,
        line: "Answer arrived",
        answerTurnId: "turn-answer-completed",
        draftTurnId: null,
        chars: 420
      });

      const finalView = recoverReviewedParent(db!, "agent", runId);
      expect(finalView?.done).toBe(true);
      expect(finalView?.status).toBe("done");
      expect(finalView?.answeredCount).toBe(1);
      expect(finalView?.children[0]?.state).toBe("answered");
      expect(finalView?.children[0]?.answerTurnId).toBe("turn-answer-completed");
      expect(finalView?.children[0]?.line).toBe("Answer arrived");
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("refuses to authorize child receipt when parent receipt body caseId is misfiled or does not match case_turn case_id", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseA = openCase(db, { title: "Case A", question: "Question A" });
      const caseB = openCase(db, { title: "Case B", question: "Question B" });

      appendTurn(
        db,
        caseA,
        {
          seat: "workstation",
          kind: "receipt",
          body: `${REVIEWED_PARENT_PREFIX}${runId}:${JSON.stringify({
            event: "parent",
            kind: "agent",
            runId,
            caseId: caseB,
            request: "Misfiled parent",
            at: 900,
            children: [{ id: "worker-0", label: "Worker", providerId: "p", modelId: "m", contextSnapshotId: "s", sourceHash: "h" }]
          })}`
        },
        900
      );

      insertAnswerTurn(db, caseB, "t-ans", "Done", "verbatim", 901);

      expect(() => {
        saveReviewedChild(db!, caseB, {
          event: "child",
          kind: "agent",
          runId,
          childId: "worker-0",
          state: "answered",
          at: 902,
          line: "Done",
          answerTurnId: "t-ans",
          draftTurnId: null,
          chars: 10
        });
      }).toThrow(/parent receipt for runId .* not found/);

      expect(() => {
        saveReviewedChild(db!, caseA, {
          event: "child",
          kind: "agent",
          runId,
          childId: "worker-0",
          state: "answered",
          at: 903,
          line: "Done",
          answerTurnId: "t-ans",
          draftTurnId: null,
          chars: 10
        });
      }).toThrow(/parent receipt for runId .* not found/);
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("distinguishes stopped before dispatch from stopped after starting across multiple receipts", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, { title: "Attempted Flag", question: "Check attempted states" });

      saveReviewedParent(db!, {
        event: "parent",
        kind: "agent",
        runId,
        caseId,
        request: "Check attempted states",
        at: 1000,
        children: [
          { id: "c-unstarted", label: "Unstarted", providerId: "p", modelId: "m", contextSnapshotId: "s", sourceHash: "h" },
          { id: "c-stopped-early", label: "Stopped Early", providerId: "p", modelId: "m", contextSnapshotId: "s", sourceHash: "h" },
          { id: "c-stopped-late", label: "Stopped Late", providerId: "p", modelId: "m", contextSnapshotId: "s", sourceHash: "h" }
        ]
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "c-stopped-early",
        state: "stopped",
        at: 1005,
        line: "Stopped before starting",
        answerTurnId: null,
        draftTurnId: null,
        chars: 0
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "c-stopped-late",
        state: "starting",
        at: 1010,
        line: "Started work",
        answerTurnId: null,
        draftTurnId: null,
        chars: 0
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "c-stopped-late",
        state: "stopped",
        at: 1015,
        line: "Cancelled after progress",
        answerTurnId: null,
        draftTurnId: "turn-draft-late",
        chars: 88
      });

      const recovered = recoverReviewedParent(db!, "agent", runId);
      expect(recovered).not.toBeNull();
      expect(recovered?.status).toBe("interrupted");
      expect(recovered?.done).toBe(false);

      const unstartedChild = recovered?.children.find((c) => c.id === "c-unstarted");
      const earlyChild = recovered?.children.find((c) => c.id === "c-stopped-early");
      const lateChild = recovered?.children.find((c) => c.id === "c-stopped-late");

      expect(unstartedChild?.state).toBe("interrupted");
      expect(unstartedChild?.attempted).toBe(false);

      expect(earlyChild?.state).toBe("stopped");
      expect(earlyChild?.attempted).toBe(false);
      expect(earlyChild?.line).toBe("Stopped before starting");

      expect(lateChild?.state).toBe("stopped");
      expect(lateChild?.attempted).toBe(true);
      expect(lateChild?.draftTurnId).toBe("turn-draft-late");
      expect(lateChild?.chars).toBe(88);
      expect(lateChild?.at).toBe(1015);
      expect(lateChild?.line).toBe("Cancelled after progress");
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("validates answerTurnId on write and rejects nonexistent, cross-case, wrong-kind, or empty IDs", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseA = openCase(db, { title: "Case A", question: "Validation A" });
      const caseB = openCase(db, { title: "Case B", question: "Validation B" });

      insertAnswerTurn(db, caseB, "turn-cross-case", "Answer in B", "verbatim", 1100);
      insertAnswerTurn(db, caseA, "turn-receipt-kind", "Receipt body", "receipt", 1101);
      insertAnswerTurn(db, caseA, "turn-valid", "Valid answer", "verbatim", 1102);

      saveReviewedParent(db!, {
        event: "parent",
        kind: "agent",
        runId,
        caseId: caseA,
        request: "Validation test",
        at: 1100,
        children: [{ id: "w-0", label: "Worker 0", providerId: "p", modelId: "m", contextSnapshotId: "s", sourceHash: "h" }]
      });

      expect(() => {
        saveReviewedChild(db!, caseA, {
          event: "child",
          kind: "agent",
          runId,
          childId: "w-0",
          state: "answered",
          at: 1103,
          line: "Null ID",
          answerTurnId: null,
          draftTurnId: null,
          chars: 10
        });
      }).toThrow(/nonempty answerTurnId/);

      expect(() => {
        saveReviewedChild(db!, caseA, {
          event: "child",
          kind: "agent",
          runId,
          childId: "w-0",
          state: "answered",
          at: 1104,
          line: "Nonexistent ID",
          answerTurnId: "turn-nonexistent",
          draftTurnId: null,
          chars: 10
        });
      }).toThrow(/does not exist/);

      expect(() => {
        saveReviewedChild(db!, caseA, {
          event: "child",
          kind: "agent",
          runId,
          childId: "w-0",
          state: "answered",
          at: 1105,
          line: "Cross case ID",
          answerTurnId: "turn-cross-case",
          draftTurnId: null,
          chars: 10
        });
      }).toThrow(/belongs to case/);

      expect(() => {
        saveReviewedChild(db!, caseA, {
          event: "child",
          kind: "agent",
          runId,
          childId: "w-0",
          state: "answered",
          at: 1106,
          line: "Wrong kind ID",
          answerTurnId: "turn-receipt-kind",
          draftTurnId: null,
          chars: 10
        });
      }).toThrow(/invalid kind/);

      const savedTurnId = saveReviewedChild(db!, caseA, {
        event: "child",
        kind: "agent",
        runId,
        childId: "w-0",
        state: "answered",
        at: 1107,
        line: "Valid answer",
        answerTurnId: "turn-valid",
        draftTurnId: null,
        chars: 100
      });
      expect(savedTurnId).toBeDefined();
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("recovers corrupt or deleted answerTurnIds as interrupted with evidence without fabricating answers", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseA = openCase(db, { title: "Case A", question: "Corrupt recovery" });
      const caseB = openCase(db, { title: "Case B", question: "Other case" });

      insertAnswerTurn(db, caseB, "turn-b-cross", "Cross-case answer", "verbatim", 1200);
      insertAnswerTurn(db, caseA, "turn-a-receipt", "Receipt turn", "receipt", 1201);
      insertAnswerTurn(db, caseA, "turn-a-deleted", "Will be deleted", "verbatim", 1202);

      saveReviewedParent(db!, {
        event: "parent",
        kind: "agent",
        runId,
        caseId: caseA,
        request: "Tolerate corrupt answer references",
        at: 1200,
        children: [
          { id: "c-missing", label: "Missing turn", providerId: "p", modelId: "m", contextSnapshotId: "s", sourceHash: "h" },
          { id: "c-cross", label: "Cross case turn", providerId: "p", modelId: "m", contextSnapshotId: "s", sourceHash: "h" },
          { id: "c-wrong", label: "Wrong kind turn", providerId: "p", modelId: "m", contextSnapshotId: "s", sourceHash: "h" },
          { id: "c-deleted", label: "Deleted turn", providerId: "p", modelId: "m", contextSnapshotId: "s", sourceHash: "h" }
        ]
      });

      appendTurn(
        db,
        caseA,
        {
          seat: "workstation",
          kind: "receipt",
          body: `${REVIEWED_PARENT_PREFIX}${runId}:${JSON.stringify({
            event: "child",
            kind: "agent",
            runId,
            childId: "c-missing",
            state: "answered",
            at: 1205,
            line: "Summary line missing",
            answerTurnId: "turn-nonexistent-id",
            draftTurnId: null,
            chars: 100
          })}`
        },
        1205
      );

      appendTurn(
        db,
        caseA,
        {
          seat: "workstation",
          kind: "receipt",
          body: `${REVIEWED_PARENT_PREFIX}${runId}:${JSON.stringify({
            event: "child",
            kind: "agent",
            runId,
            childId: "c-cross",
            state: "answered",
            at: 1206,
            line: "Summary line cross",
            answerTurnId: "turn-b-cross",
            draftTurnId: null,
            chars: 100
          })}`
        },
        1206
      );

      appendTurn(
        db,
        caseA,
        {
          seat: "workstation",
          kind: "receipt",
          body: `${REVIEWED_PARENT_PREFIX}${runId}:${JSON.stringify({
            event: "child",
            kind: "agent",
            runId,
            childId: "c-wrong",
            state: "answered",
            at: 1207,
            line: "Summary line wrong",
            answerTurnId: "turn-a-receipt",
            draftTurnId: null,
            chars: 100
          })}`
        },
        1207
      );

      saveReviewedChild(db!, caseA, {
        event: "child",
        kind: "agent",
        runId,
        childId: "c-deleted",
        state: "answered",
        at: 1208,
        line: "Summary line deleted",
        answerTurnId: "turn-a-deleted",
        draftTurnId: null,
        chars: 100
      });

      db.prepare("DELETE FROM case_turn WHERE id = ?").run("turn-a-deleted");

      const recovered = recoverReviewedParent(db!, "agent", runId);
      expect(recovered).not.toBeNull();
      expect(recovered?.done).toBe(false);
      expect(recovered?.status).toBe("interrupted");
      expect(recovered?.answeredCount).toBe(0);

      const missingChild = recovered?.children.find((c) => c.id === "c-missing");
      const crossChild = recovered?.children.find((c) => c.id === "c-cross");
      const wrongChild = recovered?.children.find((c) => c.id === "c-wrong");
      const deletedChild = recovered?.children.find((c) => c.id === "c-deleted");

      expect(missingChild?.state).toBe("interrupted");
      expect(missingChild?.attempted).toBe(true);
      expect(missingChild?.answerTurnId).toBe("turn-nonexistent-id");
      expect(missingChild?.line).toContain("needs inspection");

      expect(crossChild?.state).toBe("interrupted");
      expect(crossChild?.attempted).toBe(true);
      expect(crossChild?.answerTurnId).toBe("turn-b-cross");
      expect(crossChild?.line).toContain("needs inspection");

      expect(wrongChild?.state).toBe("interrupted");
      expect(wrongChild?.attempted).toBe(true);
      expect(wrongChild?.answerTurnId).toBe("turn-a-receipt");
      expect(wrongChild?.line).toContain("needs inspection");

      expect(deletedChild?.state).toBe("interrupted");
      expect(deletedChild?.attempted).toBe(true);
      expect(deletedChild?.answerTurnId).toBe("turn-a-deleted");
      expect(deletedChild?.line).toContain("needs inspection");
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("two bounded safe failed/unstarted continuation attempts retain distinct context hashes", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    const attemptId1 = randomUUID();
    const attemptId2 = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, { title: "Continuation Test", question: "Retain distinct hashes" });

      saveReviewedParent(db!, {
        event: "parent",
        kind: "agent",
        runId,
        caseId,
        request: "Analyze logs",
        at: 100,
        children: [
          {
            id: "child-worker",
            label: "Worker",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet",
            contextSnapshotId: "snap-1",
            sourceHash: "hash-1"
          }
        ]
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "child-worker",
        state: "starting",
        at: 101,
        line: "Starting attempt 1",
        answerTurnId: null,
        draftTurnId: null,
        chars: 0,
        attempt: {
          attemptId: attemptId1,
          contextSnapshotId: "snap-1",
          sourceHash: "hash-1",
          providerId: "anthropic",
          modelId: "claude-3-7-sonnet"
        }
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "child-worker",
        state: "failed",
        at: 102,
        line: "Attempt 1 failed",
        answerTurnId: null,
        draftTurnId: null,
        chars: 0,
        attempt: {
          attemptId: attemptId1,
          contextSnapshotId: "snap-1",
          sourceHash: "hash-1",
          providerId: "anthropic",
          modelId: "claude-3-7-sonnet"
        }
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "child-worker",
        state: "starting",
        at: 103,
        line: "Starting attempt 2",
        answerTurnId: null,
        draftTurnId: null,
        chars: 0,
        attempt: {
          attemptId: attemptId2,
          contextSnapshotId: "snap-2",
          sourceHash: "hash-2",
          providerId: "anthropic",
          modelId: "claude-3-7-sonnet"
        }
      });

      const recovered = recoverReviewedParent(db!, "agent", runId);
      expect(recovered).not.toBeNull();
      const child = recovered?.children.find((c) => c.id === "child-worker");
      expect(child).toBeDefined();
      expect(child?.attemptCount).toBe(2);
      expect(child?.attemptHistory.length).toBe(2);

      const hist1 = child!.attemptHistory[0]!;
      const hist2 = child!.attemptHistory[1]!;
      expect(hist1.attemptId).toBe(attemptId1);
      expect(hist1.contextSnapshotId).toBe("snap-1");
      expect(hist1.sourceHash).toBe("hash-1");
      expect(hist1.state).toBe("failed");
      expect(hist1.bindingVerified).toBe(true);

      expect(hist2.attemptId).toBe(attemptId2);
      expect(hist2.contextSnapshotId).toBe("snap-2");
      expect(hist2.sourceHash).toBe("hash-2");
      expect(hist2.state).toBe("interrupted");
      expect(hist2.bindingVerified).toBe(true);
      expect(hist1.sourceHash).not.toBe(hist2.sourceHash);
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("pins a Crew context role to its reviewed parent and durable attempt across restart", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-role-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    const attemptId = randomUUID();
    try {
      const db = setupTestDb(file);
      const caseId = openCase(db, { title: "Role pin", question: "Review design evidence" });
      saveReviewedParent(db, {
        event: "parent", kind: "crew", runId, caseId, request: "Review design evidence", at: 100,
        children: [{ id: "design-part", label: "Reviewer", providerId: "p", modelId: "m",
          contextSnapshotId: "snapshot-1", sourceHash: "hash-1", role: "Lead Analyst",
          contextRoleId: "design" }]
      });
      const attempt = { attemptId, contextSnapshotId: "snapshot-1", sourceHash: "hash-1",
        providerId: "p", modelId: "m", contextRoleId: "design" };
      const starting = { event: "child", kind: "crew", runId, childId: "design-part",
        state: "starting", at: 101, line: "Host admission pending", answerTurnId: null,
        draftTurnId: null, chars: 0 };
      expect(() => saveReviewedChild(db, caseId, {
        ...starting, attempt: { ...attempt, contextRoleId: "finance" }
      })).toThrow(/context role does not match reviewed parent/u);
      saveReviewedChild(db, caseId, { ...starting, attempt });
      expect(() => saveReviewedChild(db, caseId, {
        ...starting, state: "failed", at: 102, line: "Stopped", attempt: { ...attempt, contextRoleId: "finance" }
      })).toThrow(/context role does not match reviewed parent/u);
      saveReviewedChild(db, caseId, {
        ...starting, state: "failed", at: 102, line: "Stopped", attempt
      });
      db.close();
      const reopened = new DatabaseSync(file);
      reopened.exec("PRAGMA foreign_keys = ON");
      const recovered = recoverReviewedParent(reopened, "crew", runId);
      expect(recovered?.children[0]).toMatchObject({
        contextRoleId: "design", sourceHash: "hash-1", bindingVerified: true,
        attempt: { contextRoleId: "design", contextSnapshotId: "snapshot-1", sourceHash: "hash-1" }
      });
      expect(recovered?.children[0]?.attemptHistory[0]?.contextRoleId).toBe("design");
      reopened.close();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("wrong attempt/provider/snapshot terminal rejected", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    const attemptId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, { title: "Binding Rejection", question: "Reject mismatched terminal" });

      saveReviewedParent(db!, {
        event: "parent",
        kind: "agent",
        runId,
        caseId,
        request: "Reject mismatched terminal",
        at: 200,
        children: [
          {
            id: "child-worker",
            label: "Worker",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet",
            contextSnapshotId: "snap-0",
            sourceHash: "hash-0"
          }
        ]
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "child-worker",
        state: "starting",
        at: 201,
        line: "Starting work",
        answerTurnId: null,
        draftTurnId: null,
        chars: 0,
        attempt: {
          attemptId,
          contextSnapshotId: "snap-0",
          sourceHash: "hash-0",
          providerId: "anthropic",
          modelId: "claude-3-7-sonnet"
        }
      });

      expect(() => {
        saveReviewedChild(db!, caseId, {
          event: "child",
          kind: "agent",
          runId,
          childId: "child-worker",
          state: "failed",
          at: 202,
          line: "Wrong attemptId",
          answerTurnId: null,
          draftTurnId: null,
          chars: 0,
          attempt: {
            attemptId: randomUUID(),
            contextSnapshotId: "snap-0",
            sourceHash: "hash-0",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet"
          }
        });
      }).toThrow(/does not match latest start/);

      expect(() => {
        saveReviewedChild(db!, caseId, {
          event: "child",
          kind: "agent",
          runId,
          childId: "child-worker",
          state: "failed",
          at: 203,
          line: "Wrong providerId",
          answerTurnId: null,
          draftTurnId: null,
          chars: 0,
          attempt: {
            attemptId,
            contextSnapshotId: "snap-0",
            sourceHash: "hash-0",
            providerId: "openai",
            modelId: "claude-3-7-sonnet"
          }
        });
      }).toThrow(/reused with differing fields|does not match latest start/);

      expect(() => {
        saveReviewedChild(db!, caseId, {
          event: "child",
          kind: "agent",
          runId,
          childId: "child-worker",
          state: "failed",
          at: 204,
          line: "Wrong snapshot",
          answerTurnId: null,
          draftTurnId: null,
          chars: 0,
          attempt: {
            attemptId,
            contextSnapshotId: "snap-wrong",
            sourceHash: "hash-0",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet"
          }
        });
      }).toThrow(/reused with differing fields|does not match latest start/);

      expect(() => {
        saveReviewedChild(db!, caseId, {
          event: "child",
          kind: "agent",
          runId,
          childId: "child-worker",
          state: "failed",
          at: 205,
          line: "Missing attempt",
          answerTurnId: null,
          draftTurnId: null,
          chars: 0
        });
      }).toThrow(/missing attempt binding/);
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("completed child cannot restart", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    const attemptId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, { title: "Complete Restart Test", question: "Completed child cannot restart" });

      saveReviewedParent(db!, {
        event: "parent",
        kind: "agent",
        runId,
        caseId,
        request: "Do work once",
        at: 300,
        children: [
          {
            id: "child-worker",
            label: "Worker",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet",
            contextSnapshotId: "snap-0",
            sourceHash: "hash-0"
          }
        ]
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "child-worker",
        state: "starting",
        at: 301,
        line: "Starting",
        answerTurnId: null,
        draftTurnId: null,
        chars: 0,
        attempt: {
          attemptId,
          contextSnapshotId: "snap-0",
          sourceHash: "hash-0",
          providerId: "anthropic",
          modelId: "claude-3-7-sonnet"
        }
      });

      insertAnswerTurn(db, caseId, "turn-done", "Work done", "verbatim", 302);

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "child-worker",
        state: "answered",
        at: 303,
        line: "Work done",
        answerTurnId: "turn-done",
        draftTurnId: null,
        chars: 50,
        attempt: {
          attemptId,
          contextSnapshotId: "snap-0",
          sourceHash: "hash-0",
          providerId: "anthropic",
          modelId: "claude-3-7-sonnet"
        }
      });

      expect(() => {
        saveReviewedChild(db!, caseId, {
          event: "child",
          kind: "agent",
          runId,
          childId: "child-worker",
          state: "starting",
          at: 304,
          line: "Restarting completed child",
          answerTurnId: null,
          draftTurnId: null,
          chars: 0,
          attempt: {
            attemptId: randomUUID(),
            contextSnapshotId: "snap-new",
            sourceHash: "hash-new",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet"
          }
        });
      }).toThrow(/already completed/);
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("reopen yields distinct history", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    const attemptId1 = randomUUID();
    const attemptId2 = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, { title: "Reopen History Test", question: "Reopen yields distinct history" });

      saveReviewedParent(db!, {
        event: "parent",
        kind: "agent",
        runId,
        caseId,
        request: "Multiple attempts",
        at: 400,
        children: [
          {
            id: "worker-0",
            label: "Worker",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet",
            contextSnapshotId: "snap-0",
            sourceHash: "hash-0"
          }
        ]
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "worker-0",
        state: "starting",
        at: 401,
        line: "Attempt 1 start",
        answerTurnId: null,
        draftTurnId: null,
        chars: 0,
        attempt: {
          attemptId: attemptId1,
          contextSnapshotId: "snap-0",
          sourceHash: "hash-0",
          providerId: "anthropic",
          modelId: "claude-3-7-sonnet"
        }
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "worker-0",
        state: "failed",
        at: 402,
        line: "Attempt 1 failed",
        answerTurnId: null,
        draftTurnId: null,
        chars: 0,
        attempt: {
          attemptId: attemptId1,
          contextSnapshotId: "snap-0",
          sourceHash: "hash-0",
          providerId: "anthropic",
          modelId: "claude-3-7-sonnet"
        }
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "worker-0",
        state: "starting",
        at: 403,
        line: "Attempt 2 start",
        answerTurnId: null,
        draftTurnId: null,
        chars: 0,
        attempt: {
          attemptId: attemptId2,
          contextSnapshotId: "snap-1",
          sourceHash: "hash-1",
          providerId: "anthropic",
          modelId: "claude-3-7-sonnet"
        }
      });

      insertAnswerTurn(db, caseId, "turn-ans-2", "Attempt 2 answered successfully", "verbatim", 404);

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "worker-0",
        state: "answered",
        at: 405,
        line: "Attempt 2 answered successfully",
        answerTurnId: "turn-ans-2",
        draftTurnId: null,
        chars: 120,
        attempt: {
          attemptId: attemptId2,
          contextSnapshotId: "snap-1",
          sourceHash: "hash-1",
          providerId: "anthropic",
          modelId: "claude-3-7-sonnet"
        }
      });

      db.close();
      db = new DatabaseSync(file);

      const recovered = recoverReviewedParent(db!, "agent", runId);
      expect(recovered).not.toBeNull();
      const child = recovered?.children[0];
      expect(child).toBeDefined();
      expect(child?.state).toBe("answered");
      expect(child?.attemptCount).toBe(2);
      expect(child?.attemptHistory.length).toBe(2);
      expect(child?.bindingVerified).toBe(true);
      expect(child?.attempt?.attemptId).toBe(attemptId2);
      expect(child?.attemptHistory[0]!.attemptId).toBe(attemptId1);
      expect(child?.attemptHistory[0]!.state).toBe("failed");
      expect(child?.attemptHistory[1]!.attemptId).toBe(attemptId2);
      expect(child?.attemptHistory[1]!.state).toBe("answered");
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("old unbound rows explicitly unverified", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, { title: "Unbound Test", question: "Check unverified status" });

      saveReviewedParent(db!, {
        event: "parent",
        kind: "agent",
        runId,
        caseId,
        request: "Unbound legacy run",
        at: 500,
        children: [
          {
            id: "legacy-child",
            label: "Legacy",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet",
            contextSnapshotId: "snap-leg",
            sourceHash: "hash-leg"
          }
        ]
      });

      insertAnswerTurn(db, caseId, "turn-legacy", "Legacy answer", "verbatim", 501);

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "legacy-child",
        state: "answered",
        at: 502,
        line: "Legacy answer",
        answerTurnId: "turn-legacy",
        draftTurnId: null,
        chars: 60
      });

      const recovered = recoverReviewedParent(db!, "agent", runId);
      expect(recovered).not.toBeNull();
      const child = recovered?.children[0];
      expect(child).toBeDefined();
      expect(child?.state).toBe("answered");
      expect(child?.bindingVerified).toBe(false);
      expect(child?.attempt).toBeUndefined();
      expect(child?.attemptCount).toBe(1);
      expect(child?.attemptHistory.length).toBe(1);
      expect(child?.attemptHistory[0]!.bindingVerified).toBe(false);
      expect(child?.attemptHistory[0]!.attemptId).toBeUndefined();
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("unknown last attempt remains interrupted", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    const attemptId1 = randomUUID();
    const attemptId2 = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, { title: "Interrupted Attempt", question: "Unknown last attempt" });

      saveReviewedParent(db!, {
        event: "parent",
        kind: "agent",
        runId,
        caseId,
        request: "Interrupted attempt check",
        at: 600,
        children: [
          {
            id: "child-0",
            label: "Worker",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet",
            contextSnapshotId: "snap-0",
            sourceHash: "hash-0"
          }
        ]
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "child-0",
        state: "starting",
        at: 601,
        line: "Attempt 1",
        answerTurnId: null,
        draftTurnId: null,
        chars: 0,
        attempt: {
          attemptId: attemptId1,
          contextSnapshotId: "snap-0",
          sourceHash: "hash-0",
          providerId: "anthropic",
          modelId: "claude-3-7-sonnet"
        }
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "child-0",
        state: "failed",
        at: 602,
        line: "Attempt 1 failed",
        answerTurnId: null,
        draftTurnId: null,
        chars: 0,
        attempt: {
          attemptId: attemptId1,
          contextSnapshotId: "snap-0",
          sourceHash: "hash-0",
          providerId: "anthropic",
          modelId: "claude-3-7-sonnet"
        }
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "child-0",
        state: "starting",
        at: 603,
        line: "Attempt 2 in progress",
        answerTurnId: null,
        draftTurnId: null,
        chars: 0,
        attempt: {
          attemptId: attemptId2,
          contextSnapshotId: "snap-1",
          sourceHash: "hash-1",
          providerId: "anthropic",
          modelId: "claude-3-7-sonnet"
        }
      });

      const recovered = recoverReviewedParent(db!, "agent", runId);
      expect(recovered).not.toBeNull();
      expect(recovered?.status).toBe("interrupted");
      const child = recovered?.children[0];
      expect(child).toBeDefined();
      expect(child?.state).toBe("interrupted");
      expect(child?.attempted).toBe(true);
      expect(child?.attemptCount).toBe(2);
      expect(child?.attemptHistory[1]!.state).toBe("interrupted");
      expect(child?.attemptHistory[1]!.attemptId).toBe(attemptId2);
      expect(child?.line).toContain("The child was attempted before the app stopped");
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("queued never-started receipt doesn't increment attempts", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, { title: "Queued Unstarted", question: "Never started child" });

      saveReviewedParent(db!, {
        event: "parent",
        kind: "agent",
        runId,
        caseId,
        request: "Queued unstarted check",
        at: 700,
        children: [
          {
            id: "child-queued",
            label: "Queued Worker",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet",
            contextSnapshotId: "snap-q",
            sourceHash: "hash-q"
          }
        ]
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "child-queued",
        state: "stopped",
        at: 701,
        line: "Stopped before starting",
        answerTurnId: null,
        draftTurnId: null,
        chars: 0
      });

      const recovered = recoverReviewedParent(db!, "agent", runId);
      expect(recovered).not.toBeNull();
      const child = recovered?.children[0];
      expect(child).toBeDefined();
      expect(child?.state).toBe("stopped");
      expect(child?.attempted).toBe(false);
      expect(child?.attemptCount).toBe(0);
      expect(child?.attemptHistory.length).toBe(0);
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("rejects second start before prior start terminates and retains original history", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    const attemptId1 = randomUUID();
    const attemptId2 = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, { title: "Uncertain Start", question: "Reject start before terminal" });

      saveReviewedParent(db!, {
        event: "parent",
        kind: "agent",
        runId,
        caseId,
        request: "Uncertain start regression",
        at: 800,
        children: [
          {
            id: "child-worker",
            label: "Worker",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet",
            contextSnapshotId: "snap-0",
            sourceHash: "hash-0"
          }
        ]
      });

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "agent",
        runId,
        childId: "child-worker",
        state: "starting",
        at: 801,
        line: "Starting attempt 1",
        answerTurnId: null,
        draftTurnId: null,
        chars: 0,
        attempt: {
          attemptId: attemptId1,
          contextSnapshotId: "snap-0",
          sourceHash: "hash-0",
          providerId: "anthropic",
          modelId: "claude-3-7-sonnet"
        }
      });

      expect(() => {
        saveReviewedChild(db!, caseId, {
          event: "child",
          kind: "agent",
          runId,
          childId: "child-worker",
          state: "starting",
          at: 802,
          line: "Starting attempt 2",
          answerTurnId: null,
          draftTurnId: null,
          chars: 0,
          attempt: {
            attemptId: attemptId2,
            contextSnapshotId: "snap-1",
            sourceHash: "hash-1",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet"
          }
        });
      }).toThrow(/prior start.*no matching terminal/);

      db.close();
      db = new DatabaseSync(file);

      const recovered = recoverReviewedParent(db!, "agent", runId);
      expect(recovered).not.toBeNull();
      const child = recovered?.children[0];
      expect(child).toBeDefined();
      expect(child?.attemptCount).toBe(1);
      expect(child?.attemptHistory.length).toBe(1);
      expect(child?.attemptHistory[0]!.attemptId).toBe(attemptId1);
      expect(child?.attemptHistory[0]!.contextSnapshotId).toBe("snap-0");
      expect(child?.attemptHistory[0]!.sourceHash).toBe("hash-0");
      expect(child?.attemptHistory[0]!.state).toBe("interrupted");
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("retains role, fixed work bytes, expectedOutput, and integrationOwner across real SQLite reopen", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, {
        title: "Metadata Retention",
        question: "Preserve package prompt and metadata"
      });

      const fixedWork = "  Immutable prompt package with exact bytes  \nline2  ";
      const parentRecord: ReviewedParentRecord = {
        event: "parent",
        kind: "crew",
        runId,
        caseId,
        request: "Execute crew run",
        integrationOwner: "child-worker",
        at: 1000,
        children: [
          {
            id: "child-worker",
            label: "Analyst",
            title: "Security Scan",
            role: "Security Analyst",
            work: fixedWork,
            expectedOutput: "Markdown vulnerability report",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet",
            contextSnapshotId: "snap-sec",
            sourceHash: "hash-sec"
          }
        ]
      };

      saveReviewedParent(db!, parentRecord);

      insertAnswerTurn(db!, caseId, "turn-ans-sec", "Report generated", "verbatim", 1001);

      saveReviewedChild(db!, caseId, {
        event: "child",
        kind: "crew",
        runId,
        childId: "child-worker",
        state: "answered",
        at: 1002,
        line: "Report generated",
        answerTurnId: "turn-ans-sec",
        draftTurnId: null,
        chars: 16
      });

      db.close();
      db = new DatabaseSync(file);

      const recovered = recoverReviewedParent(db!, "crew", runId);
      expect(recovered).not.toBeNull();
      expect(recovered?.integrationOwner).toBe("child-worker");

      const child = recovered?.children[0];
      expect(child).toBeDefined();
      expect(child?.title).toBe("Security Scan");
      expect(child?.role).toBe("Security Analyst");
      expect(child?.work).toBe(fixedWork);
      expect(child?.expectedOutput).toBe("Markdown vulnerability report");
      expect(child?.state).toBe("answered");
      expect(child?.attempted).toBe(true);
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("rejects invalid integration owner and empty or oversized metadata fields", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, {
        title: "Validation Suite",
        question: "Enforce bounded metadata"
      });

      const baseParent: ReviewedParentRecord = {
        event: "parent",
        kind: "crew",
        runId,
        caseId,
        request: "Validation check",
        at: 2000,
        children: [
          {
            id: "child-1",
            label: "Child 1",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet",
            contextSnapshotId: "snap-1",
            sourceHash: "hash-1"
          }
        ]
      };

      expect(() => {
        saveReviewedParent(db!, {
          ...baseParent,
          integrationOwner: "nonexistent-child"
        });
      }).toThrow(/Invalid integration owner/);

      expect(() => {
        saveReviewedParent(db!, {
          ...baseParent,
          integrationOwner: ""
        });
      }).toThrow();

      expect(() => {
        saveReviewedParent(db!, {
          ...baseParent,
          children: [
            {
              ...baseParent.children[0],
              title: ""
            }
          ]
        });
      }).toThrow();

      expect(() => {
        saveReviewedParent(db!, {
          ...baseParent,
          children: [
            {
              ...baseParent.children[0],
              role: ""
            }
          ]
        });
      }).toThrow();

      expect(() => {
        saveReviewedParent(db!, {
          ...baseParent,
          children: [
            {
              ...baseParent.children[0],
              work: ""
            }
          ]
        });
      }).toThrow();

      expect(() => {
        saveReviewedParent(db!, {
          ...baseParent,
          children: [
            {
              ...baseParent.children[0],
              expectedOutput: ""
            }
          ]
        });
      }).toThrow();

      expect(() => {
        saveReviewedParent(db!, {
          ...baseParent,
          children: [
            {
              ...baseParent.children[0],
              work: "a".repeat(2001)
            }
          ]
        });
      }).toThrow();
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("older records without metadata remain readable with explicit absence", () => {
    const folder = mkdtempSync(join(tmpdir(), "reviewed-parent-test-"));
    const file = join(folder, "book.db");
    const runId = randomUUID();
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      const caseId = openCase(db, {
        title: "Legacy Run",
        question: "Check missing metadata absence"
      });

      const legacyParent: ReviewedParentRecord = {
        event: "parent",
        kind: "agent",
        runId,
        caseId,
        request: "Legacy prompt",
        at: 3000,
        children: [
          {
            id: "legacy-child",
            label: "Legacy Worker",
            providerId: "anthropic",
            modelId: "claude-3-7-sonnet",
            contextSnapshotId: "snap-leg",
            sourceHash: "hash-leg"
          }
        ]
      };

      saveReviewedParent(db!, legacyParent);

      db.close();
      db = new DatabaseSync(file);

      const recovered = recoverReviewedParent(db!, "agent", runId);
      expect(recovered).not.toBeNull();
      expect(recovered?.integrationOwner).toBeUndefined();

      const child = recovered?.children[0];
      expect(child).toBeDefined();
      expect(child?.title).toBeUndefined();
      expect(child?.role).toBeUndefined();
      expect(child?.work).toBeUndefined();
      expect(child?.expectedOutput).toBeUndefined();
      expect(child?.state).toBe("interrupted");
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
