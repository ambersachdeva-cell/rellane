/**
 * Proves that reading Today items and listing Cases across the IPC boundary
 * preserves waiting cases untouched regardless of their age, defending D-096.
 *
 * Before D-096, an automatic sweep ran whenever Today items or the Cases list
 * were read, unilaterally marking cases whose last turn was older than thirty days
 * as abandoned. That conflated waiting with abandonment: an owner awaiting an
 * external resolution or tax assessment for weeks would find their case closed
 * behind their back simply by opening the app.
 *
 * This test exercises the Electron IPC boundary directly against an isolated,
 * persistent SQLite book on disk. It verifies that neither today.read nor
 * cases.list mutates open cases (even zero-turn or 31+ day old cases), that
 * historical turns and legacy closure fields remain completely intact, that new
 * owner turns append properly through cases.say, and that cases only close when
 * the owner explicitly invokes cases.close.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { CaseRoom, CaseSummary } from "@cadrane/contracts";

const electron = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event: unknown, input?: unknown) => Promise<unknown>
  >();
  return {
    handlers,
    exposedBridge: null as unknown,
    exposed: {} as Record<string, unknown>,
    invoke: vi.fn(async () => undefined),
    showOpenDialog: vi.fn(async () => ({
      canceled: true,
      filePaths: []
    }))
  };
});

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getPath: () => "/tmp/switchboard-main-data"
  },
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => {
      electron.exposed[name] = value;
      if (name === "cadrane") {
        electron.exposedBridge = value;
      }
    }
  },
  dialog: {
    showOpenDialog: electron.showOpenDialog
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, input?: unknown) => Promise<unknown>
    ) => {
      electron.handlers.set(channel, handler);
    }
  },
  ipcRenderer: {
    invoke: electron.invoke
  },
  utilityProcess: {
    fork: vi.fn()
  }
}));

import { installIpcHandlers, IPC_CHANNELS, useBook, closeBook } from "./ipc.js";
import { openCase, appendTurn, closeCase, readCase, turnsFor } from "./book/cases.js";

function fixture(
  request: (...args: unknown[]) => Promise<unknown> = async () => undefined
) {
  const sender = new EventEmitter() as EventEmitter & {
    getURL(): string;
    mainFrame: unknown;
    session: { getStoragePath(): string };
  };
  const frame = { url: "switchboard://app/index.html" };
  sender.getURL = () => frame.url;
  sender.mainFrame = frame;
  sender.session = {
    getStoragePath: () => "/tmp/switchboard-main-data"
  };
  const window = {
    webContents: sender
  };
  const event = {
    sender,
    senderFrame: frame
  };
  return {
    daemon: { request } as never,
    getWindow: () => window as never,
    event,
    sender
  };
}

function handler(channel: string) {
  const registered = electron.handlers.get(channel);
  if (registered === undefined) {
    throw new Error(`Missing fixture IPC handler for ${channel}.`);
  }
  return registered;
}

describe("cases retention regression (D-096)", () => {
  let bookDir: string;

  beforeEach(async () => {
    electron.handlers.clear();
    electron.invoke.mockClear();
    bookDir = await mkdtemp(join(tmpdir(), "cadrane-test-book-"));
  });

  afterEach(async () => {
    closeBook();
    await rm(bookDir, { recursive: true, force: true });
  });

  it("retains cases untouched for 31 days instead of closing them", async () => {
    const { daemon, getWindow, event } = fixture(vi.fn(async () => undefined));
    installIpcHandlers(daemon, getWindow);

    await useBook(bookDir);
    closeBook();

    const dbPath = join(bookDir, "book.sqlite");
    let testDb: DatabaseSync | null = null;

    try {
      testDb = new DatabaseSync(dbPath);

      const thirtyTwoDaysAgo = Date.now() - 32 * 24 * 60 * 60 * 1000;

      // 1. Case opened and last touched over 31 days ago
      const case1Id = openCase(
        testDb,
        { title: "Old Case", question: "Why is the bill open?" },
        thirtyTwoDaysAgo
      );
      const turn1Id = appendTurn(
        testDb,
        case1Id,
        { seat: "owner", kind: "verbatim", body: "Original turn 1" },
        thirtyTwoDaysAgo
      );

      // 2. Equally old Case with zero turns
      const case2Id = openCase(
        testDb,
        { title: "Empty Old Case", question: "Awaiting first response" },
        thirtyTwoDaysAgo
      );

      // 3. Legacy closedAs abandoned case with synthetic original turn
      const case3Id = openCase(
        testDb,
        { title: "Abandoned Case", question: "Dropped inquiry" },
        thirtyTwoDaysAgo
      );
      const turn3Id = appendTurn(
        testDb,
        case3Id,
        { seat: "owner", kind: "verbatim", body: "Original turn 3" },
        thirtyTwoDaysAgo
      );
      closeCase(
        testDb,
        case3Id,
        { closedAs: "abandoned", verdict: "Gave up waiting" },
        thirtyTwoDaysAgo
      );

      // 4. Legacy closedAs settled case with synthetic original turn
      const case4Id = openCase(
        testDb,
        { title: "Settled Case", question: "Resolved dispute" },
        thirtyTwoDaysAgo
      );
      const turn4Id = appendTurn(
        testDb,
        case4Id,
        { seat: "owner", kind: "verbatim", body: "Original turn 4" },
        thirtyTwoDaysAgo
      );
      closeCase(
        testDb,
        case4Id,
        { closedAs: "settled", verdict: "Resolved by credit" },
        thirtyTwoDaysAgo
      );

      // Snapshot all four seeded rows and turns before IPC actions
      const snapshot1 = {
        row: readCase(testDb, case1Id)!,
        turns: turnsFor(testDb, case1Id)
      };
      const snapshot2 = {
        row: readCase(testDb, case2Id)!,
        turns: turnsFor(testDb, case2Id)
      };
      const snapshot3 = {
        row: readCase(testDb, case3Id)!,
        turns: turnsFor(testDb, case3Id)
      };
      const snapshot4 = {
        row: readCase(testDb, case4Id)!,
        turns: turnsFor(testDb, case4Id)
      };

      expect(snapshot1.turns.length).toBe(1);
      expect(snapshot1.turns[0]?.id).toBe(turn1Id);
      expect(snapshot2.turns.length).toBe(0);
      expect(snapshot3.turns.length).toBe(1);
      expect(snapshot3.turns[0]?.id).toBe(turn3Id);
      expect(snapshot4.turns.length).toBe(1);
      expect(snapshot4.turns[0]?.id).toBe(turn4Id);

      testDb.close();
      testDb = null;

      // Reopen through IPC setup
      await useBook(bookDir);

      // Exercise Today and Cases list handlers across the IPC boundary
      await handler(IPC_CHANNELS.todayRead)(event);
      const listResult = (await handler(IPC_CHANNELS.casesList)(event)) as {
        cases: readonly CaseSummary[];
        closedAsAbandoned: number;
      };

      expect(listResult.closedAsAbandoned).toBe(0);

      // Verify domain database state matches snapshots exactly after IPC reads
      testDb = new DatabaseSync(dbPath);

      const c1 = readCase(testDb, case1Id)!;
      expect(c1.closedAt).toBeNull();
      expect(c1.closedAs).toBeNull();
      expect(c1.verdict).toBeNull();
      expect(c1.openedAt).toBe(snapshot1.row.openedAt);
      expect(turnsFor(testDb, case1Id)).toEqual(snapshot1.turns);

      const c2 = readCase(testDb, case2Id)!;
      expect(c2.closedAt).toBeNull();
      expect(c2.closedAs).toBeNull();
      expect(c2.verdict).toBeNull();
      expect(c2.openedAt).toBe(snapshot2.row.openedAt);
      expect(turnsFor(testDb, case2Id)).toEqual(snapshot2.turns);

      const c3 = readCase(testDb, case3Id)!;
      expect(c3.closedAt).toBe(snapshot3.row.closedAt);
      expect(c3.closedAs).toBe("abandoned");
      expect(c3.verdict).toBe("Gave up waiting");
      expect(c3.openedAt).toBe(snapshot3.row.openedAt);
      expect(turnsFor(testDb, case3Id)).toEqual(snapshot3.turns);

      const c4 = readCase(testDb, case4Id)!;
      expect(c4.closedAt).toBe(snapshot4.row.closedAt);
      expect(c4.closedAs).toBe("settled");
      expect(c4.verdict).toBe("Resolved by credit");
      expect(c4.openedAt).toBe(snapshot4.row.openedAt);
      expect(turnsFor(testDb, case4Id)).toEqual(snapshot4.turns);

      testDb.close();
      testDb = null;

      // Verify summaries reported in the Cases list
      const summary1 = listResult.cases.find((c) => c.id === case1Id);
      expect(summary1).toBeDefined();
      expect(summary1?.closedAt).toBeNull();
      expect(summary1?.closedAs).toBeNull();
      expect(summary1?.verdict).toBeNull();
      expect(summary1?.turns).toBe(1);

      const summary2 = listResult.cases.find((c) => c.id === case2Id);
      expect(summary2).toBeDefined();
      expect(summary2?.closedAt).toBeNull();
      expect(summary2?.closedAs).toBeNull();
      expect(summary2?.verdict).toBeNull();
      expect(summary2?.turns).toBe(0);

      const summary3 = listResult.cases.find((c) => c.id === case3Id);
      expect(summary3).toBeDefined();
      expect(summary3?.closedAt).toBe(snapshot3.row.closedAt);
      expect(summary3?.closedAs).toBe("abandoned");
      expect(summary3?.verdict).toBe("Gave up waiting");
      expect(summary3?.turns).toBe(1);

      const summary4 = listResult.cases.find((c) => c.id === case4Id);
      expect(summary4).toBeDefined();
      expect(summary4?.closedAt).toBe(snapshot4.row.closedAt);
      expect(summary4?.closedAs).toBe("settled");
      expect(summary4?.verdict).toBe("Resolved by credit");
      expect(summary4?.turns).toBe(1);

      // Exercise new owner turn via casesSay IPC handler
      const sayResult = (await handler(IPC_CHANNELS.casesSay)(event, {
        id: case1Id,
        body: "Owner continuation turn"
      })) as CaseRoom;

      expect(sayResult.case).not.toBeNull();
      expect(sayResult.case?.id).toBe(case1Id);
      expect(sayResult.case?.closedAt).toBeNull();
      expect(sayResult.case?.closedAs).toBeNull();
      expect(sayResult.case?.verdict).toBeNull();
      expect(sayResult.case?.turns).toBe(2);

      expect(sayResult.turns.length).toBe(2);
      expect(sayResult.turns[0]).toEqual(snapshot1.turns[0]);

      expect(sayResult.turns[1]?.seq).toBe(2);
      expect(sayResult.turns[1]?.seat).toBe("owner");
      expect(sayResult.turns[1]?.kind).toBe("verbatim");
      expect(sayResult.turns[1]?.body).toBe("Owner continuation turn");

      // Verify reading through casesRead IPC handler
      const readAfterSay = (await handler(IPC_CHANNELS.casesRead)(event, {
        id: case1Id
      })) as CaseRoom;

      expect(readAfterSay.case?.closedAt).toBeNull();
      expect(readAfterSay.case?.turns).toBe(2);
      expect(readAfterSay.turns.length).toBe(2);
      expect(readAfterSay.turns[0]?.body).toBe("Original turn 1");
      expect(readAfterSay.turns[1]?.body).toBe("Owner continuation turn");

      // Remains open after closing and reopening the Book
      closeBook();
      await useBook(bookDir);

      const readAfterReopen = (await handler(IPC_CHANNELS.casesRead)(event, {
        id: case1Id
      })) as CaseRoom;

      expect(readAfterReopen.case?.closedAt).toBeNull();
      expect(readAfterReopen.case?.turns).toBe(2);

      // Explicit owner close via casesClose IPC handler
      const closeResult1 = (await handler(IPC_CHANNELS.casesClose)(event, {
        id: case1Id,
        verdict: "Explicit owner verdict"
      })) as { closed: boolean; case: CaseSummary | null };

      expect(closeResult1.closed).toBe(true);
      expect(closeResult1.case).not.toBeNull();
      expect(closeResult1.case?.id).toBe(case1Id);
      expect(typeof closeResult1.case?.closedAt).toBe("number");
      expect(closeResult1.case?.closedAs).toBe("settled");
      expect(closeResult1.case?.verdict).toBe("Explicit owner verdict");
      const closedTimestamp = closeResult1.case?.closedAt;

      // Repeated close via casesClose IPC handler remains idempotent
      const closeResult2 = (await handler(IPC_CHANNELS.casesClose)(event, {
        id: case1Id,
        verdict: "Ignored second verdict"
      })) as { closed: boolean; case: CaseSummary | null };

      expect(closeResult2.closed).toBe(false);
      expect(closeResult2.case?.closedAt).toBe(closedTimestamp);
      expect(closeResult2.case?.verdict).toBe("Explicit owner verdict");

      // Verify room state through casesRead IPC handler
      const readAfterClose = (await handler(IPC_CHANNELS.casesRead)(event, {
        id: case1Id
      })) as CaseRoom;

      expect(readAfterClose.case?.closedAt).toBe(closedTimestamp);
      expect(readAfterClose.case?.closedAs).toBe("settled");
      expect(readAfterClose.case?.verdict).toBe("Explicit owner verdict");
      expect(readAfterClose.turns.length).toBe(2);
      expect(readAfterClose.turns[0]?.body).toBe("Original turn 1");
      expect(readAfterClose.turns[1]?.body).toBe("Owner continuation turn");

      // Verify domain database matches exact final state
      testDb = new DatabaseSync(dbPath);
      const finalC1 = readCase(testDb, case1Id)!;
      expect(finalC1.closedAt).toBe(closedTimestamp);
      expect(finalC1.closedAs).toBe("settled");
      expect(finalC1.verdict).toBe("Explicit owner verdict");

      const finalTurns1 = turnsFor(testDb, case1Id);
      expect(finalTurns1.length).toBe(2);
      expect(finalTurns1[0]?.body).toBe("Original turn 1");
      expect(finalTurns1[1]?.body).toBe("Owner continuation turn");

      testDb.close();
      testDb = null;
    } finally {
      testDb?.close();
    }
  });
});
