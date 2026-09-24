import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { closeCase, openCase } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { MAX_HITS, type SearchOutcome } from "./book-search.js";
import { installWorkstationBookSearch } from "./book-search-ipc.js";

const f = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) => {
      f.handlers.set(name, handler);
    }
  }
}));

describe("Workstation book search IPC", () => {
  let db: DatabaseSync;
  let caseId: string;
  let event: IpcMainInvokeEvent;
  let sender: EventEmitter;
  let trusted: boolean;
  let bookThrows: boolean;
  let allTurnsMock: ReturnType<typeof vi.fn>;

  const invoke = (channel: string, input: unknown) => {
    const handler = f.handlers.get(channel);
    if (!handler) {
      throw new Error(`Handler not registered for channel: ${channel}`);
    }
    return Promise.resolve().then(() => handler(event, input));
  };

  beforeEach(() => {
    vi.resetAllMocks();
    f.handlers.clear();
    trusted = true;
    bookThrows = false;
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (const migration of MIGRATIONS) {
      db.exec(migration.sql);
    }
    caseId = openCase(db, { title: "Research notes", question: "Quarterly review" });
    sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    event = { sender, senderFrame: {} } as unknown as IpcMainInvokeEvent;

    allTurnsMock = vi.fn((_db: DatabaseSync) => [
      {
        id: "turn-default",
        caseId,
        caseTitle: "Research notes",
        seat: "owner",
        kind: "dialogue",
        body: "Default turnover analysis notes",
        at: 1000
      }
    ]);

    installWorkstationBookSearch({
      assertTrusted: () => {
        if (!trusted) {
          throw new Error("Untrusted sender");
        }
      },
      book: () => {
        if (bookThrows) {
          throw new Error("Notebook database unavailable");
        }
        return db;
      },
      // vi.fn() widens to Procedure; the installer wants the real signature.
      allTurns: allTurnsMock as unknown as Parameters<typeof installWorkstationBookSearch>[0]["allTurns"]
    });
  });

  afterEach(() => {
    db.close();
  });

  it("rejects untrusted sender before database operations", async () => {
    trusted = false;
    await expect(
      invoke(IPC_CHANNELS.workstationBookSearch, { query: "hello" })
    ).rejects.toThrow("Untrusted sender");
    expect(allTurnsMock).not.toHaveBeenCalled();
  });

  it("returns an empty outcome for empty query without reading the book", async () => {
    const result = await invoke(IPC_CHANNELS.workstationBookSearch, { query: "" });
    expect(result).toEqual({
      hits: [],
      scanned: 0,
      matched: 0,
      summary: "0 matches across 0 pieces of work."
    });
    expect(allTurnsMock).not.toHaveBeenCalled();
  });

  it("returns an empty outcome for whitespace-only query without reading the book", async () => {
    const result = await invoke(IPC_CHANNELS.workstationBookSearch, "   ");
    expect(result).toEqual({
      hits: [],
      scanned: 0,
      matched: 0,
      summary: "0 matches across 0 pieces of work."
    });
    expect(allTurnsMock).not.toHaveBeenCalled();
  });

  it("returns an empty outcome when the book throws upon opening", async () => {
    bookThrows = true;
    const result = await invoke(IPC_CHANNELS.workstationBookSearch, { query: "test query" });
    expect(result).toEqual({
      hits: [],
      scanned: 0,
      matched: 0,
      summary: "The book is not open yet."
    });
  });

  it("returns an empty outcome when allTurns throws", async () => {
    allTurnsMock.mockImplementationOnce(() => {
      throw new Error("Disk I/O failure");
    });
    const result = await invoke(IPC_CHANNELS.workstationBookSearch, { query: "test query" });
    expect(result).toEqual({
      hits: [],
      scanned: 0,
      matched: 0,
      summary: "The book is not open yet."
    });
  });

  it("bounds search results to MAX_HITS", async () => {
    const turns: {
      readonly id: string;
      readonly caseId: string;
      readonly caseTitle: string;
      readonly seat: string;
      readonly kind: string;
      readonly body: string;
      readonly at: number;
    }[] = [];

    for (let i = 0; i < 60; i++) {
      turns.push({
        id: `turn-${i}`,
        caseId,
        caseTitle: "Search test",
        seat: "owner",
        kind: "dialogue",
        body: `This contains the target search term alpha in turn ${i}`,
        at: 1000 + i
      });
    }
    allTurnsMock.mockReturnValue(turns);

    const result = (await invoke(IPC_CHANNELS.workstationBookSearch, {
      query: "alpha"
    })) as SearchOutcome;

    expect(result.matched).toBe(60);
    expect(result.hits.length).toBe(MAX_HITS);
    expect(result.hits.length).toBe(50);
  });

  it("handles rapid successive calls quietly without erroring", async () => {
    allTurnsMock.mockReturnValue([
      {
        id: "turn-1",
        caseId,
        caseTitle: "Search test",
        seat: "owner",
        kind: "dialogue",
        body: "Concurrent typing query match",
        at: 1000
      }
    ]);

    const [res1, res2, res3] = (await Promise.all([
      invoke(IPC_CHANNELS.workstationBookSearch, { query: "Concurrent" }),
      invoke(IPC_CHANNELS.workstationBookSearch, { query: "Concurrent typ" }),
      invoke(IPC_CHANNELS.workstationBookSearch, { query: "Concurrent typing" })
    ])) as [SearchOutcome, SearchOutcome, SearchOutcome];

    expect(res1.hits.length).toBe(1);
    expect(res2.hits.length).toBe(1);
    expect(res3.hits.length).toBe(1);
    expect(allTurnsMock).toHaveBeenCalledTimes(1);
  });

  it("never logs the query to console or elsewhere", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const canary = "secret-canary-query-token-777";
      await invoke(IPC_CHANNELS.workstationBookSearch, { query: canary });

      const allCalls = [
        ...logSpy.mock.calls,
        ...infoSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls
      ];

      for (const call of allCalls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain(canary);
        }
      }
    } finally {
      logSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("filters out turns belonging to closed or erased cases", async () => {
    const closedCaseId = openCase(db, { title: "Settled work", question: "Settled question" });
    closeCase(db, closedCaseId, { closedAs: "settled", verdict: "Completed" });

    allTurnsMock.mockReturnValue([
      {
        id: "open-turn",
        caseId,
        caseTitle: "Active work",
        seat: "owner",
        kind: "dialogue",
        body: "Finding the secret project revenue report",
        at: 2000
      },
      {
        id: "closed-turn",
        caseId: closedCaseId,
        caseTitle: "Settled work",
        seat: "owner",
        kind: "dialogue",
        body: "Finding the secret project revenue report from old days",
        at: 1000
      },
      {
        id: "erased-turn",
        caseId: "non-existent-case-id",
        caseTitle: "Erased work",
        seat: "owner",
        kind: "dialogue",
        body: "Finding the secret project revenue report erased",
        at: 500
      }
    ]);

    const result = (await invoke(IPC_CHANNELS.workstationBookSearch, {
      query: "secret revenue"
    })) as SearchOutcome;

    expect(result.matched).toBe(1);
    expect(result.hits.length).toBe(1);
    const firstHit = result.hits[0];
    expect(firstHit).toBeDefined();
    if (!firstHit) {
      throw new Error("Expected at least one hit");
    }
    expect(firstHit.turnId).toBe("open-turn");
    expect(firstHit.caseId).toBe(caseId);
  });

  it("finds a turn by exact phrase and formats snippet with highlights", async () => {
    allTurnsMock.mockReturnValue([
      {
        id: "budget-turn",
        caseId,
        caseTitle: "Q3 Budget Review",
        seat: "owner",
        kind: "dialogue",
        body: "We reviewed the finances and the annual budget was approved by the board yesterday.",
        at: 1700000000000
      }
    ]);

    const result = (await invoke(IPC_CHANNELS.workstationBookSearch, {
      query: '"annual budget was approved"'
    })) as SearchOutcome;

    expect(result.matched).toBe(1);
    expect(result.hits.length).toBe(1);
    const hit = result.hits[0];
    expect(hit).toBeDefined();
    if (!hit) {
      throw new Error("Expected at least one hit");
    }
    expect(hit.turnId).toBe("budget-turn");
    expect(hit.who).toBe("You");
    expect(hit.snippet).toContain("annual budget was approved");
    expect(hit.highlights.length).toBeGreaterThan(0);
  });

  it("rejects if window navigates mid-search", async () => {
    let frame = { id: 1 };
    const dynamicEvent = {
      sender,
      get senderFrame() {
        return frame;
      }
    } as unknown as IpcMainInvokeEvent;

    allTurnsMock.mockImplementationOnce(() => {
      frame = { id: 2 };
      return [
        {
          id: "turn-1",
          caseId,
          caseTitle: "Search test",
          seat: "owner",
          kind: "dialogue",
          body: "target term match",
          at: 1000
        }
      ];
    });

    const handler = f.handlers.get(IPC_CHANNELS.workstationBookSearch);
    if (!handler) {
      throw new Error("Handler not registered");
    }

    await expect(handler(dynamicEvent, { query: "target" })).rejects.toThrow(
      "This window changed while searching."
    );
  });

  it("rejects malformed and oversized input payloads", async () => {
    await expect(
      invoke(IPC_CHANNELS.workstationBookSearch, { query: 12345 })
    ).rejects.toThrow();

    await expect(
      invoke(IPC_CHANNELS.workstationBookSearch, { invalidField: "test" })
    ).rejects.toThrow();

    await expect(
      invoke(IPC_CHANNELS.workstationBookSearch, { query: "a".repeat(4001) })
    ).rejects.toThrow();
  });
});
