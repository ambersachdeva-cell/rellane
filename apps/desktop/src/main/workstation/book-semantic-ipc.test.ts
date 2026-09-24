import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  installSemanticSearch,
  SemanticSearchEngine,
  type InstallSemanticSearchOptions,
  type SearchableTurn,
} from "./book-semantic-ipc.js";

type IpcHandler = (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>;

const handlers = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));

let currentSenderId = "window-a";

vi.mock("../agents/source-owner.js", () => ({
  createAgentSourceOwners: () => {
    return (sender: unknown) => {
      if (sender === "changed-sender") {
        return "window-b";
      }
      return currentSenderId;
    };
  },
}));

describe("Semantic search over workstation book", () => {
  beforeEach(() => {
    handlers.clear();
    currentSenderId = "window-a";
  });

  it("answers with word matching and mode 'words' when embed is null", async () => {
    const turns: readonly SearchableTurn[] = [
      {
        id: "turn-1",
        caseId: "case-1",
        caseTitle: "Supplier dispute",
        body: "The delayed shipment of ceramics from Stoke is arriving on Friday.",
        at: 1000,
      },
      {
        id: "turn-2",
        caseId: "case-2",
        caseTitle: "Quarterly taxes",
        body: "HMRC payment due next Tuesday.",
        at: 2000,
      },
    ];

    const engine = new SemanticSearchEngine({
      searchable: () => turns,
      embed: null,
    });

    const status = engine.getStatus();
    expect(status.ready).toBe(false);
    expect(status.detail).toBe("No local language model installed. Searches will match on exact words.");
    expect(status.indexed).toBe(0);

    const result = await engine.search("delayed shipment");
    expect(result.mode).toBe("words");
    expect(result.summary).toBe("Matched on the words you typed. Install a local language model to search by meaning.");
    expect(result.hits.length).toBe(1);
    expect(result.hits[0]!.turnId).toBe("turn-1");
    expect(result.hits[0]!.why).toBe("mentions 'delayed' and 'shipment'");
    expect(result.hits[0]!.snippet).toContain("delayed shipment");
  });

  it("returns meaning match with mode 'meaning' when query shares no words with turn", async () => {
    const turns: readonly SearchableTurn[] = [
      {
        id: "turn-1",
        caseId: "case-1",
        caseTitle: "Logistics update",
        body: "The delayed shipment arrived at the warehouse.",
        at: 1000,
      },
      {
        id: "turn-2",
        caseId: "case-2",
        caseTitle: "Office stationery",
        body: "Purchased new printer paper and pens.",
        at: 2000,
      },
    ];

    const embedStub = vi.fn(async (texts: readonly string[], _signal: AbortSignal) => {
      return texts.map((text) => {
        const lower = text.toLowerCase();
        if (lower.includes("cargo") || lower.includes("shipment") || lower.includes("late") || lower.includes("delayed")) {
          return [1, 0] as const;
        }
        return [0, 1] as const;
      });
    });

    const engine = new SemanticSearchEngine({
      searchable: () => turns,
      embed: embedStub,
    });

    const result = await engine.search("late cargo");
    expect(result.mode).toBe("meaning");
    expect(result.hits.length).toBe(1);
    expect(result.hits[0]!.turnId).toBe("turn-1");
    expect(result.hits[0]!.why).toBe("close in meaning to your question");
    expect(result.summary).toBe("Found 1 result matching your question.");

    const status = engine.getStatus();
    expect(status.ready).toBe(true);
    expect(status.indexed).toBe(2);
  });

  it("returns no hits and plain summary for empty or whitespace query without touching index", async () => {
    const searchableSpy = vi.fn(() => []);
    const embedSpy = vi.fn();

    const engine = new SemanticSearchEngine({
      searchable: searchableSpy,
      embed: embedSpy,
    });

    const result = await engine.search("   ");
    expect(result.hits).toHaveLength(0);
    expect(result.summary).toBe("Type words or a question to search your work.");
    expect(searchableSpy).not.toHaveBeenCalled();
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("lazily builds the index on first search and reuses it for subsequent searches", async () => {
    let turns: readonly SearchableTurn[] = [
      {
        id: "turn-1",
        caseId: "case-1",
        caseTitle: "Draft contract",
        body: "Initial agreement terms for review.",
        at: 1000,
      },
    ];

    const embedSpy = vi.fn(async (texts: readonly string[]) => {
      return texts.map(() => [1, 0] as const);
    });

    const engine = new SemanticSearchEngine({
      searchable: () => turns,
      embed: embedSpy,
    });

    expect(engine.getStatus().indexed).toBe(0);

    await engine.search("contract terms");
    expect(engine.getStatus().indexed).toBe(1);
    const firstCallCount = embedSpy.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    await engine.search("contract review");
    const secondCallCount = embedSpy.mock.calls.length;
    expect(secondCallCount).toBe(firstCallCount + 1);

    turns = [
      {
        id: "turn-1",
        caseId: "case-1",
        caseTitle: "Draft contract",
        body: "Updated agreement terms signed by both parties.",
        at: 2000,
      },
    ];

    await engine.search("signed agreement");
    const thirdCallCount = embedSpy.mock.calls.length;
    expect(thirdCallCount).toBe(secondCallCount + 2);
  });

  it("caps the index at 20,000 turns and says so in summary", async () => {
    const count = 20_005;
    const turns: SearchableTurn[] = [];
    for (let i = 0; i < count; i++) {
      turns.push({
        id: `turn-${i}`,
        caseId: "case-bulk",
        caseTitle: "Bulk load",
        body: `Shipment record item number ${i} in ledger.`,
        at: i,
      });
    }

    const engine = new SemanticSearchEngine({
      searchable: () => turns,
      embed: null,
    });

    const result = await engine.search("shipment");
    expect(result.summary).toContain("Index capped at 20,000 turns.");
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it("joins an in-progress index build rather than starting a second", async () => {
    const turns: readonly SearchableTurn[] = [
      {
        id: "turn-1",
        caseId: "case-1",
        caseTitle: "Notice",
        body: "Urgent shipment arrived at warehouse.",
        at: 1000,
      },
    ];

    let resolveTurnEmbed!: (vectors: readonly (readonly number[])[]) => void;
    const turnEmbedPromise = new Promise<readonly (readonly number[])[]>((resolve) => {
      resolveTurnEmbed = resolve;
    });

    let turnEmbedCalled = 0;

    const embedMock = vi.fn(async (texts: readonly string[]) => {
      if (texts.length === 1 && texts[0]!.includes("Urgent shipment")) {
        turnEmbedCalled++;
        return turnEmbedPromise;
      }
      return texts.map(() => [1, 0] as const);
    });

    const engine = new SemanticSearchEngine({
      searchable: () => turns,
      embed: embedMock,
    });

    const search1 = engine.search("shipment");
    const search2 = engine.search("warehouse");

    resolveTurnEmbed([[1, 0]]);

    const [res1, res2] = await Promise.all([search1, search2]);

    expect(res1.hits.length).toBe(1);
    expect(res2.hits.length).toBe(1);
    expect(turnEmbedCalled).toBe(1);
  });

  it("wires IPC handlers and enforces schema limits and trusted sender checks", async () => {
    let trustedCalled = false;
    const options: InstallSemanticSearchOptions = {
      assertTrusted: () => {
        trustedCalled = true;
      },
      searchable: () => [],
      embed: null,
    };

    installSemanticSearch(options);

    const searchHandler = handlers.get(IPC_CHANNELS.workstationSemanticSearch);
    const statusHandler = handlers.get(IPC_CHANNELS.workstationSemanticStatus);

    expect(searchHandler).toBeDefined();
    expect(statusHandler).toBeDefined();

    const mockEvent = { sender: {}, senderFrame: {} } as unknown as IpcMainInvokeEvent;

    const status = await statusHandler!(mockEvent, {});
    expect(trustedCalled).toBe(true);
    expect((status as { ready: boolean }).ready).toBe(false);

    const oversizeQuery = "a".repeat(1001);
    await expect(searchHandler!(mockEvent, { query: oversizeQuery })).rejects.toThrow(
      "Search query must be 1,000 characters or fewer."
    );

    const untrustedOptions: InstallSemanticSearchOptions = {
      assertTrusted: () => {
        throw new Error("Sender is not trusted.");
      },
      searchable: () => [],
      embed: null,
    };
    installSemanticSearch(untrustedOptions);
    const untrustedSearchHandler = handlers.get(IPC_CHANNELS.workstationSemanticSearch)!;
    await expect(untrustedSearchHandler(mockEvent, { query: "valid" })).rejects.toThrow(
      "Sender is not trusted."
    );
  });

  it("aborts when window owner changes across await", async () => {
    let ownerSwitched = false;
    const options: InstallSemanticSearchOptions = {
      assertTrusted: () => {},
      searchable: () => [
        {
          id: "turn-1",
          caseId: "case-1",
          caseTitle: "Test",
          body: "Waiting on response.",
          at: 1000,
        },
      ],
      embed: async (texts: readonly string[]) => {
        currentSenderId = "window-b";
        ownerSwitched = true;
        return texts.map(() => [1, 0] as const);
      },
    };

    installSemanticSearch(options);
    const searchHandler = handlers.get(IPC_CHANNELS.workstationSemanticSearch)!;
    const mockEvent = { sender: {}, senderFrame: {} } as unknown as IpcMainInvokeEvent;

    await expect(searchHandler(mockEvent, { query: "waiting" })).rejects.toThrow(
      "This window changed while searching."
    );
    expect(ownerSwitched).toBe(true);
  });
});
