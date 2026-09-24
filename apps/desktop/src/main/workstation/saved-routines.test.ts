/**
 * Tests for durable workstation routine persistence and versioning.
 *
 * Verifies create, versioned updates, optimistic conflict rejection,
 * provenance validation/immutability, DPDP case erasure safety,
 * exact Unicode preservation, and persistence across database reopening.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../book/schema.js";
import { appendTurn, eraseCase, openCase, readCase } from "../book/cases.js";
import {

  listSavedWorkstationRoutines,
  saveWorkstationRoutine,
  savedWorkstationRoutineVersions
} from "./saved-routines.js";

/** Creates an in-memory test database using the current book migrations. */
function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
  }

  return db;
}

describe("saved workstation routines", () => {
  it("creates and saves a starter routine without originating provenance", () => {
    const db = createTestDb();
    const timestamp = 1_700_000_000_000;

    const saved = saveWorkstationRoutine(
      db,
      {
        title: "Landing Page Draft",
        description: "Produces initial landing page brief and layout structure.",
        prompt: "Review the attached business notes and write a 3-section landing page outline.",
        sourceHint: "Attach client enquiry and pricing brief.",
        outputLabel: "Landing Page Brief",
        icon: "write"
      },
      timestamp
    );

    expect(saved.id).toBeTypeOf("string");
    expect(saved.revision).toBe(1);
    expect(saved.createdAt).toBe(timestamp);
    expect(saved.updatedAt).toBe(timestamp);
    expect(saved.originCaseId).toBeNull();
    expect(saved.originTurnId).toBeNull();
    expect(saved.title).toBe("Landing Page Draft");
    expect(saved.icon).toBe("write");

    const list = listSavedWorkstationRoutines(db);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(saved.id);
    expect(list[0]?.title).toBe("Landing Page Draft");

    const versions = savedWorkstationRoutineVersions(db, saved.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.revision).toBe(1);
    expect(versions[0]?.prompt).toBe(
      "Review the attached business notes and write a 3-section landing page outline."
    );
  });

  it("appends immutable revisions on update and preserves version history", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Research Workroom", question: "How to draft copy?" });
    const turnId = appendTurn(db, caseId, {
      seat: "owner",
      kind: "verbatim",
      body: "Draft a high-conversion landing page structure."
    });

    const t1 = 1_700_000_000_000;
    const v1 = saveWorkstationRoutine(
      db,
      {
        title: "Initial Routine",
        description: "First version description.",
        prompt: "First version prompt text.",
        sourceHint: "Source hint v1.",
        outputLabel: "Output v1",
        icon: "build",
        originCaseId: caseId,
        originTurnId: turnId
      },
      t1
    );

    expect(v1.revision).toBe(1);
    expect(v1.originCaseId).toBe(caseId);
    expect(v1.originTurnId).toBe(turnId);

    const t2 = t1 + 10_000;
    const v2 = saveWorkstationRoutine(
      db,
      {
        id: v1.id,
        expectedRevision: 1,
        title: "Updated Routine Title",
        description: "Second version description.",
        prompt: "Second version refined prompt text.",
        sourceHint: "Source hint v2.",
        outputLabel: "Output v2",
        icon: "build"
      },
      t2
    );

    expect(v2.revision).toBe(2);
    expect(v2.createdAt).toBe(t1);
    expect(v2.updatedAt).toBe(t2);
    expect(v2.originCaseId).toBe(caseId);
    expect(v2.originTurnId).toBe(turnId);

    const t3 = t2 + 10_000;
    const v3 = saveWorkstationRoutine(
      db,
      {
        id: v1.id,
        expectedRevision: 2,
        title: "Final Routine Title",
        description: "Third version description.",
        prompt: "Third version final prompt text.",
        sourceHint: "Source hint v3.",
        outputLabel: "Output v3",
        icon: "review"
      },
      t3
    );

    expect(v3.revision).toBe(3);
    expect(v3.updatedAt).toBe(t3);

    const currentList = listSavedWorkstationRoutines(db);
    expect(currentList).toHaveLength(1);
    expect(currentList[0]?.revision).toBe(3);
    expect(currentList[0]?.title).toBe("Final Routine Title");
    expect(currentList[0]?.icon).toBe("review");
    expect(currentList[0]?.updatedAt).toBe(t3);

    const history = savedWorkstationRoutineVersions(db, v1.id);
    expect(history).toHaveLength(3);
    expect(history.map((v) => v.revision)).toEqual([1, 2, 3]);
    expect(history[0]?.prompt).toBe("First version prompt text.");
    expect(history[0]?.updatedAt).toBe(t1);
    expect(history[1]?.prompt).toBe("Second version refined prompt text.");
    expect(history[1]?.updatedAt).toBe(t2);
    expect(history[2]?.prompt).toBe("Third version final prompt text.");
    expect(history[2]?.updatedAt).toBe(t3);
  });

  it("rejects updates with stale expectedRevision and preserves existing data", () => {
    const db = createTestDb();
    const routine = saveWorkstationRoutine(db, {
      title: "Base Routine",
      description: "Base description",
      prompt: "Base prompt",
      sourceHint: "Base hint",
      outputLabel: "Base label",
      icon: "research"
    });

    saveWorkstationRoutine(db, {
      id: routine.id,
      expectedRevision: 1,
      title: "Revision 2 Title",
      description: "Revision 2 description",
      prompt: "Revision 2 prompt",
      sourceHint: "Revision 2 hint",
      outputLabel: "Revision 2 label",
      icon: "research"
    });

    expect(() =>
      saveWorkstationRoutine(db, {
        id: routine.id,
        expectedRevision: 1,
        title: "Stale Overwrite Attempt",
        description: "Should be rejected",
        prompt: "Should never land",
        sourceHint: "Should never land",
        outputLabel: "Should never land",
        icon: "research"
      })
    ).toThrow(/stale revision conflict/iu);

    const currentList = listSavedWorkstationRoutines(db);
    expect(currentList).toHaveLength(1);
    expect(currentList[0]?.revision).toBe(2);
    expect(currentList[0]?.title).toBe("Revision 2 Title");

    const versions = savedWorkstationRoutineVersions(db, routine.id);
    expect(versions).toHaveLength(2);
    expect(versions.some((v) => v.title === "Stale Overwrite Attempt")).toBe(false);
  });

  it("rejects non-verbatim receipt turns, cross-case turn references, and non-existent turns", () => {
    const db = createTestDb();
    const caseA = openCase(db, { title: "Case A", question: "Question A" });
    const turnAVerbatim = appendTurn(db, caseA, {
      seat: "owner",
      kind: "verbatim",
      body: "Verbatim request from owner"
    });
    const turnAReceipt = appendTurn(db, caseA, {
      seat: "workstation-session",
      kind: "receipt",
      body: JSON.stringify({ receipt: "session-receipt-data" })
    });

    const caseB = openCase(db, { title: "Case B", question: "Question B" });
    const turnBVerbatim = appendTurn(db, caseB, {
      seat: "owner",
      kind: "verbatim",
      body: "Verbatim request from Case B"
    });

    expect(() =>
      saveWorkstationRoutine(db, {
        title: "Receipt Provenance Routine",
        description: "Should fail",
        prompt: "Prompt text",
        sourceHint: "Hint",
        outputLabel: "Label",
        icon: "data",
        originCaseId: caseA,
        originTurnId: turnAReceipt
      })
    ).toThrow(/must be verbatim/iu);

    expect(() =>
      saveWorkstationRoutine(db, {
        title: "Cross Case Routine",
        description: "Should fail",
        prompt: "Prompt text",
        sourceHint: "Hint",
        outputLabel: "Label",
        icon: "data",
        originCaseId: caseA,
        originTurnId: turnBVerbatim
      })
    ).toThrow(/not indicated case/iu);

    expect(() =>
      saveWorkstationRoutine(db, {
        title: "Missing Turn Routine",
        description: "Should fail",
        prompt: "Prompt text",
        sourceHint: "Hint",
        outputLabel: "Label",
        icon: "data",
        originCaseId: caseA,
        originTurnId: "00000000-0000-0000-0000-000000000000"
      })
    ).toThrow(/does not exist/iu);

    const valid = saveWorkstationRoutine(db, {
      title: "Valid Provenance Routine",
      description: "Valid description",
      prompt: "Valid prompt",
      sourceHint: "Valid hint",
      outputLabel: "Valid label",
      icon: "data",
      originCaseId: caseA,
      originTurnId: turnAVerbatim
    });
    expect(valid.originCaseId).toBe(caseA);
    expect(valid.originTurnId).toBe(turnAVerbatim);
  });

  it("enforces provenance immutability across subsequent edits", () => {
    const db = createTestDb();
    const caseA = openCase(db, { title: "Case A", question: "QA" });
    const turnA = appendTurn(db, caseA, { seat: "owner", kind: "verbatim", body: "Turn A" });

    const caseB = openCase(db, { title: "Case B", question: "QB" });
    const turnB = appendTurn(db, caseB, { seat: "owner", kind: "verbatim", body: "Turn B" });

    const routine = saveWorkstationRoutine(db, {
      title: "Origin Routine",
      description: "Description",
      prompt: "Prompt",
      sourceHint: "Hint",
      outputLabel: "Label",
      icon: "write",
      originCaseId: caseA,
      originTurnId: turnA
    });

    expect(() =>
      saveWorkstationRoutine(db, {
        id: routine.id,
        expectedRevision: 1,
        title: "Modified Routine",
        description: "Description",
        prompt: "Prompt",
        sourceHint: "Hint",
        outputLabel: "Label",
        icon: "write",
        originCaseId: caseB,
        originTurnId: turnB
      })
    ).toThrow(/provenance is immutable/iu);

    const updated = saveWorkstationRoutine(db, {
      id: routine.id,
      expectedRevision: 1,
      title: "Modified Routine Valid",
      description: "Updated description",
      prompt: "Updated prompt",
      sourceHint: "Hint",
      outputLabel: "Label",
      icon: "write"
    });

    expect(updated.originCaseId).toBe(caseA);
    expect(updated.originTurnId).toBe(turnA);
    expect(updated.revision).toBe(2);

    const unattached = saveWorkstationRoutine(db, {
      title: "Unattached Routine",
      description: "Description",
      prompt: "Prompt",
      sourceHint: "Hint",
      outputLabel: "Label",
      icon: "write"
    });

    expect(() =>
      saveWorkstationRoutine(db, {
        id: unattached.id,
        expectedRevision: 1,
        title: "Unattached Modified",
        description: "Description",
        prompt: "Prompt",
        sourceHint: "Hint",
        outputLabel: "Label",
        icon: "write",
        originCaseId: caseA,
        originTurnId: turnA
      })
    ).toThrow(/provenance is immutable/iu);
  });

  it("preserves reusable routine and its provenance pointer when originating case is erased", () => {
    const db = createTestDb();
    const caseId = openCase(db, {
      title: "Sensitive Negotiation Case",
      question: "Client asked for custom quotation"
    });
    const turnId = appendTurn(db, caseId, {
      seat: "owner",
      kind: "verbatim",
      body: "Format response with itemised tax breakdown and net payable total."
    });

    const routine = saveWorkstationRoutine(db, {
      title: "Tax Breakdown Template",
      description: "Learned procedure for itemised tax tables.",
      prompt: "Structure the final quotation response into standard HSN/SAC tax line items.",
      sourceHint: "Quotation drafts",
      outputLabel: "Tax Table",
      icon: "data",
      originCaseId: caseId,
      originTurnId: turnId
    });

    const erased = eraseCase(db, caseId);
    expect(erased).toBe(true);
    expect(readCase(db, caseId)).toBeNull();

    const list = listSavedWorkstationRoutines(db);
    expect(list.some((r) => r.id === routine.id)).toBe(true);

    const found = list.find((r) => r.id === routine.id);
    expect(found?.originCaseId).toBe(caseId);
    expect(found?.originTurnId).toBe(turnId);
    expect(found?.title).toBe("Tax Breakdown Template");

    const rev2 = saveWorkstationRoutine(db, {
      id: routine.id,
      expectedRevision: 1,
      title: "Tax Breakdown Template v2",
      description: "Updated description after case erasure",
      prompt: "Updated prompt text",
      sourceHint: "Quotation drafts",
      outputLabel: "Tax Table",
      icon: "data"
    });
    expect(rev2.revision).toBe(2);
    expect(rev2.originCaseId).toBe(caseId);
    expect(rev2.originTurnId).toBe(turnId);
  });

  it("preserves exact Unicode, emoji, quotes, tabs, and multi-line CRLF/LF templates without drift", () => {
    const db = createTestDb();
    const complexPrompt =
      "### कार्य योजना (Work Plan)\r\n" +
      "- ग्राहक नाम: शर्मा ट्रेडर्स (Sharma Traders) ₹4,000 आउटस्टैंडिंग\n" +
      "- Status: 📋 \"Review Required\" & 50% discount 'pending'\t[TAB]\n" +
      "\n" +
      "```json\n" +
      "{\n" +
      "  \"tax_bp\": 1800,\n" +
      "  \"symbol\": \"₹\"\n" +
      "}\n" +
      "```\n";

    const complexTitle = "कोटेशन सत्यापन 📋✨ (₹4,000)";
    const complexDescription = "विशेष हिंदी व अंग्रेजी टेम्पलेट — line 1\nline 2";

    const routine = saveWorkstationRoutine(db, {
      title: complexTitle,
      description: complexDescription,
      prompt: complexPrompt,
      sourceHint: "विस्तृत विवरण (Details)\t[TAB]",
      outputLabel: "आउटपुट परिणाम 🎯",
      icon: "review"
    });

    const retrieved = listSavedWorkstationRoutines(db).find((r) => r.id === routine.id);
    expect(retrieved?.title).toBe(complexTitle);
    expect(retrieved?.description).toBe(complexDescription);
    expect(retrieved?.prompt).toBe(complexPrompt);
    expect(retrieved?.sourceHint).toBe("विस्तृत विवरण (Details)\t[TAB]");
    expect(retrieved?.outputLabel).toBe("आउटपुट परिणाम 🎯");
  });

  it("persists saved routines and version history across closing and reopening a temporary database file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rellane-routines-test-"));
    const dbFile = join(tempDir, "book.sqlite");

    try {
      let db = new DatabaseSync(dbFile);
      db.exec("PRAGMA foreign_keys = ON");
      for (const migration of MIGRATIONS) {
        db.exec(migration.sql);
      }


      const t1 = 1_700_000_000_000;
      const initial = saveWorkstationRoutine(
        db,
        {
          title: "Persistent Routine",
          description: "Persists across reopen",
          prompt: "Initial prompt text",
          sourceHint: "Source hint",
          outputLabel: "Output label",
          icon: "build"
        },
        t1
      );

      const t2 = t1 + 5_000;
      saveWorkstationRoutine(
        db,
        {
          id: initial.id,
          expectedRevision: 1,
          title: "Persistent Routine v2",
          description: "Updated description across reopen",
          prompt: "Updated prompt text",
          sourceHint: "Source hint",
          outputLabel: "Output label",
          icon: "build"
        },
        t2
      );

      db.close();

      db = new DatabaseSync(dbFile);
      db.exec("PRAGMA foreign_keys = ON");

      const routines = listSavedWorkstationRoutines(db);
      expect(routines).toHaveLength(1);
      expect(routines[0]?.id).toBe(initial.id);
      expect(routines[0]?.revision).toBe(2);
      expect(routines[0]?.title).toBe("Persistent Routine v2");
      expect(routines[0]?.createdAt).toBe(t1);
      expect(routines[0]?.updatedAt).toBe(t2);

      const versions = savedWorkstationRoutineVersions(db, initial.id);
      expect(versions).toHaveLength(2);
      expect(versions[0]?.revision).toBe(1);
      expect(versions[0]?.prompt).toBe("Initial prompt text");
      expect(versions[1]?.revision).toBe(2);
      expect(versions[1]?.prompt).toBe("Updated prompt text");

      db.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
