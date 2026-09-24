import { describe, expect, it } from "vitest";
import {
  sessionRows,
  summariseRunning,
  type SnapshotLike,
  type SessionRow
} from "./running-sessions.js";

function makeSnapshot(overrides: Partial<SnapshotLike> = {}): SnapshotLike {
  return {
    operationId: overrides.operationId ?? "op-default",
    caseId: overrides.caseId ?? "case-default",
    caseTitle: overrides.caseTitle ?? "Default task",
    providerLabel: overrides.providerLabel ?? "Codex",
    status: overrides.status ?? "running",
    detail: overrides.detail ?? "Reading project files",
    startedAt: overrides.startedAt ?? 1_000,
    updatedAt: overrides.updatedAt ?? 2_000,
    waitingTitle: overrides.waitingTitle ?? null
  };
}

describe("running-sessions", () => {
  describe("ordering and state mapping", () => {
    it("sorts a needs-approval session above a running one that updated more recently", () => {
      const snapshots: readonly SnapshotLike[] = [
        makeSnapshot({
          operationId: "op-running-recent",
          status: "running",
          updatedAt: 5_000
        }),
        makeSnapshot({
          operationId: "op-needs-approval",
          status: "needs-approval",
          updatedAt: 1_000,
          waitingTitle: "Confirm tool call"
        })
      ];

      const rows = sessionRows(snapshots, 10_000);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.operationId).toBe("op-needs-approval");
      expect(rows[0]!.state).toBe("needs-approval");
      expect(rows[1]!.operationId).toBe("op-running-recent");
      expect(rows[1]!.state).toBe("running");
    });

    it("sorts groups by needs-approval, running, starting, stopping, done, then updatedAt desc and operationId asc", () => {
      const snapshots: readonly SnapshotLike[] = [
        makeSnapshot({ operationId: "op-done", status: "completed", updatedAt: 9_000 }),
        makeSnapshot({ operationId: "op-start", status: "starting", updatedAt: 4_000 }),
        makeSnapshot({ operationId: "op-stop", status: "stopping", updatedAt: 3_000 }),
        makeSnapshot({ operationId: "op-run-b", status: "running", updatedAt: 5_000 }),
        makeSnapshot({ operationId: "op-run-a", status: "running", updatedAt: 5_000 }),
        makeSnapshot({ operationId: "op-run-older", status: "running", updatedAt: 2_000 }),
        makeSnapshot({ operationId: "op-approval", status: "needs-approval", updatedAt: 1_000 })
      ];

      const rows = sessionRows(snapshots, 10_000);
      expect(rows).toHaveLength(7);
      expect(rows[0]!.operationId).toBe("op-approval");
      expect(rows[1]!.operationId).toBe("op-run-a");
      expect(rows[2]!.operationId).toBe("op-run-b");
      expect(rows[3]!.operationId).toBe("op-run-older");
      expect(rows[4]!.operationId).toBe("op-start");
      expect(rows[5]!.operationId).toBe("op-stop");
      expect(rows[6]!.operationId).toBe("op-done");
    });

    it("maps unknown status to running without dropping the session", () => {
      const snapshots: readonly SnapshotLike[] = [
        makeSnapshot({
          operationId: "op-unknown",
          status: "unexpected_custom_status",
          caseTitle: "Investigate unknown status"
        })
      ];

      const rows = sessionRows(snapshots, 2_000);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.operationId).toBe("op-unknown");
      expect(rows[0]!.state).toBe("running");
      expect(rows[0]!.canStop).toBe(true);
      expect(rows[0]!.needsYou).toBe(false);
    });

    it("sets canStop to false only when done", () => {
      const snapshots: readonly SnapshotLike[] = [
        makeSnapshot({ operationId: "op-done-1", status: "completed" }),
        makeSnapshot({ operationId: "op-done-2", status: "stopped" }),
        makeSnapshot({ operationId: "op-done-3", status: "failed" }),
        makeSnapshot({ operationId: "op-done-4", status: "interrupted" }),
        makeSnapshot({ operationId: "op-running", status: "running" })
      ];

      const rows = sessionRows(snapshots, 10_000);
      expect(rows).toHaveLength(5);
      const running = rows.find((r) => r.operationId === "op-running");
      expect(running?.canStop).toBe(true);

      const doneRows = rows.filter((r) => r.operationId.startsWith("op-done"));
      expect(doneRows).toHaveLength(4);
      for (const doneRow of doneRows) {
        expect(doneRow.state).toBe("done");
        expect(doneRow.canStop).toBe(false);
      }
    });
  });

  describe("elapsed formatting", () => {
    it("formats 45s, 90s, 61min, and negative or non-finite difference properly", () => {
      const now = 100_000_000;
      const snapshots: readonly SnapshotLike[] = [
        makeSnapshot({ operationId: "op-45s", startedAt: now - 45_000 }),
        makeSnapshot({ operationId: "op-90s", startedAt: now - 90_000 }),
        makeSnapshot({ operationId: "op-61m", startedAt: now - 61 * 60 * 1_000 }),
        makeSnapshot({ operationId: "op-neg", startedAt: now + 5_000 }),
        makeSnapshot({ operationId: "op-nan", startedAt: Number.NaN })
      ];

      const rows = sessionRows(snapshots, now);
      const row45s = rows.find((r) => r.operationId === "op-45s");
      const row90s = rows.find((r) => r.operationId === "op-90s");
      const row61m = rows.find((r) => r.operationId === "op-61m");
      const rowNeg = rows.find((r) => r.operationId === "op-neg");
      const rowNan = rows.find((r) => r.operationId === "op-nan");

      expect(row45s?.elapsed).toBe("45 sec");
      expect(row90s?.elapsed).toBe("1 min");
      expect(row61m?.elapsed).toBe("1 hr 1 min");
      expect(rowNeg?.elapsed).toBe("just now");
      expect(rowNan?.elapsed).toBe("just now");
    });
  });

  describe("line formatting", () => {
    it("prefers waitingTitle when needs-approval", () => {
      const snapshots: readonly SnapshotLike[] = [
        makeSnapshot({
          operationId: "op-wait",
          status: "needs-approval",
          detail: "Background processing",
          waitingTitle: "Review folder export permission"
        })
      ];

      const rows = sessionRows(snapshots, 5_000);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.line).toBe("Review folder export permission");
      expect(rows[0]!.needsYou).toBe(true);
    });

    it("cuts an 81-character detail to 80 with one …", () => {
      const detail81 = "a".repeat(81);
      const snapshots: readonly SnapshotLike[] = [
        makeSnapshot({
          operationId: "op-long-line",
          detail: detail81
        })
      ];

      const rows = sessionRows(snapshots, 5_000);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.line).toBe("a".repeat(80) + "…");
    });

    it("replaces an empty or whitespace detail with Working.", () => {
      const snapshots: readonly SnapshotLike[] = [
        makeSnapshot({
          operationId: "op-empty-detail",
          detail: "    "
        })
      ];

      const rows = sessionRows(snapshots, 5_000);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.line).toBe("Working.");
    });
  });

  describe("title formatting", () => {
    it("replaces empty title with Untitled work", () => {
      const snapshots: readonly SnapshotLike[] = [
        makeSnapshot({
          operationId: "op-no-title",
          caseTitle: "    "
        })
      ];

      const rows = sessionRows(snapshots, 5_000);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe("Untitled work");
    });

    it("cuts a 50-character title at 40 characters with …", () => {
      const title50 = "x".repeat(50);
      const snapshots: readonly SnapshotLike[] = [
        makeSnapshot({
          operationId: "op-long-title",
          caseTitle: title50
        })
      ];

      const rows = sessionRows(snapshots, 5_000);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe("x".repeat(40) + "…");
    });
  });

  describe("summariseRunning", () => {
    it("returns Nothing running for an empty list", () => {
      expect(summariseRunning([])).toBe("Nothing running");
    });

    it("handles single session singular form", () => {
      const row: SessionRow = {
        operationId: "op-1",
        caseId: "case-1",
        title: "Design brief",
        provider: "Claude",
        state: "running",
        line: "Working.",
        elapsed: "12 sec",
        needsYou: false,
        canStop: true
      };

      expect(summariseRunning([row])).toBe("1 session working");
    });

    it("summarises mixed states and omits zero categories", () => {
      const rows: readonly SessionRow[] = [
        {
          operationId: "op-1",
          caseId: "c-1",
          title: "Task 1",
          provider: "Codex",
          state: "running",
          line: "Working.",
          elapsed: "4 min",
          needsYou: false,
          canStop: true
        },
        {
          operationId: "op-2",
          caseId: "c-2",
          title: "Task 2",
          provider: "Gemini",
          state: "running",
          line: "Working.",
          elapsed: "3 min",
          needsYou: false,
          canStop: true
        },
        {
          operationId: "op-3",
          caseId: "c-3",
          title: "Task 3",
          provider: "Claude",
          state: "running",
          line: "Working.",
          elapsed: "2 min",
          needsYou: false,
          canStop: true
        },
        {
          operationId: "op-4",
          caseId: "c-4",
          title: "Task 4",
          provider: "Local",
          state: "needs-approval",
          line: "Approve patch",
          elapsed: "1 min",
          needsYou: true,
          canStop: true
        }
      ];

      expect(summariseRunning(rows)).toBe("3 sessions working, 1 needs you");
    });

    it("pluralises need you when multiple sessions await the owner", () => {
      const rows: readonly SessionRow[] = [
        {
          operationId: "op-1",
          caseId: "c-1",
          title: "Task 1",
          provider: "Codex",
          state: "needs-approval",
          line: "Approve 1",
          elapsed: "1 min",
          needsYou: true,
          canStop: true
        },
        {
          operationId: "op-2",
          caseId: "c-2",
          title: "Task 2",
          provider: "Claude",
          state: "needs-approval",
          line: "Approve 2",
          elapsed: "2 min",
          needsYou: true,
          canStop: true
        }
      ];

      expect(summariseRunning(rows)).toBe("2 need you");
    });
  });

  describe("purity and determinism", () => {
    it("is deterministic across repeated calls and does not mutate input", () => {
      const input: readonly SnapshotLike[] = Object.freeze([
        makeSnapshot({ operationId: "op-2", updatedAt: 1_000, status: "running" }),
        makeSnapshot({ operationId: "op-1", updatedAt: 2_000, status: "needs-approval" })
      ]);

      const call1 = sessionRows(input, 10_000);
      const call2 = sessionRows(input, 10_000);

      expect(call1).toEqual(call2);
      expect(summariseRunning(call1)).toBe(summariseRunning(call2));
      expect(input[0]!.operationId).toBe("op-2");
      expect(input[1]!.operationId).toBe("op-1");
    });
  });
});
