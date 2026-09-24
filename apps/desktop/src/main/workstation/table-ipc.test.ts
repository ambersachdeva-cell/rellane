import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { installWorkstationTable } from "./table-ipc.js";

const f = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>()
}));

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/synthetic/desktop" },
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>) => {
      f.handlers.set(name, handler);
    }
  }
}));

describe("Workstation table IPC", () => {
  let event: IpcMainInvokeEvent;
  let sender: EventEmitter;
  let trusted: boolean;
  let sourceTextMap: Map<string, string>;

  const invoke = (channel: string, input: unknown) => {
    const handler = f.handlers.get(channel);
    if (!handler) {
      throw new Error(`No handler registered for channel: ${channel}`);
    }
    return handler(event, input);
  };

  const mockSourceText = vi.fn(async (caseId: string, sourceTurnId: string): Promise<string | null> => {
    const key = `${caseId}:${sourceTurnId}`;
    return sourceTextMap.get(key) ?? null;
  });

  beforeEach(() => {
    vi.resetAllMocks();
    f.handlers.clear();
    trusted = true;
    sourceTextMap = new Map();
    sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    event = { sender, senderFrame: {} } as unknown as IpcMainInvokeEvent;

    installWorkstationTable({
      assertTrusted: () => {
        if (!trusted) {
          throw new Error("Untrusted sender");
        }
      },
      sourceText: mockSourceText
    });
  });

  it("rejects untrusted sender before accessing source text", async () => {
    trusted = false;

    await expect(
      invoke(IPC_CHANNELS.workstationTableParse, {
        caseId: "case-1",
        sourceTurnId: "turn-1"
      })
    ).rejects.toThrow("Untrusted sender");

    await expect(
      invoke(IPC_CHANNELS.workstationTableQuery, {
        caseId: "case-1",
        sourceTurnId: "turn-1",
        spec: { filters: [] }
      })
    ).rejects.toThrow("Untrusted sender");

    expect(mockSourceText).not.toHaveBeenCalled();
  });

  it("refuses an unknown source id", async () => {
    await expect(
      invoke(IPC_CHANNELS.workstationTableParse, {
        caseId: "case-1",
        sourceTurnId: "missing-turn"
      })
    ).rejects.toThrow("was not found in this work");

    await expect(
      invoke(IPC_CHANNELS.workstationTableQuery, {
        caseId: "case-1",
        sourceTurnId: "missing-turn",
        spec: { filters: [] }
      })
    ).rejects.toThrow("was not found in this work");
  });

  it("refuses a malformed QuerySpec by schema validation before accessing source", async () => {
    sourceTextMap.set("case-1:turn-1", "Name,Amount\nAlpha,100");

    await expect(
      invoke(IPC_CHANNELS.workstationTableQuery, {
        caseId: "case-1",
        sourceTurnId: "turn-1",
        spec: {
          filters: [{ column: -1, op: "is", value: "Alpha" }]
        }
      })
    ).rejects.toThrow();

    await expect(
      invoke(IPC_CHANNELS.workstationTableQuery, {
        caseId: "case-1",
        sourceTurnId: "turn-1",
        spec: {
          filters: [{ column: 0, op: "not-a-valid-op", value: "Alpha" }]
        }
      })
    ).rejects.toThrow();

    expect(mockSourceText).not.toHaveBeenCalled();
  });

  it("re-parses table rather than caching when source text changes", async () => {
    sourceTextMap.set("case-1:turn-1", "Product,Cost\nWidget,₹100\n");

    const firstResult = (await invoke(IPC_CHANNELS.workstationTableQuery, {
      caseId: "case-1",
      sourceTurnId: "turn-1",
      spec: {
        filters: [],
        aggregate: { column: 1, fn: "sum" }
      }
    })) as { readonly summary: string; readonly total: number };

    expect(firstResult.total).toBe(1);
    expect(firstResult.summary).toContain("₹100");

    sourceTextMap.set("case-1:turn-1", "Product,Cost\nWidget,₹100\nGadget,₹250\n");

    const secondResult = (await invoke(IPC_CHANNELS.workstationTableQuery, {
      caseId: "case-1",
      sourceTurnId: "turn-1",
      spec: {
        filters: [],
        aggregate: { column: 1, fn: "sum" }
      }
    })) as { readonly summary: string; readonly total: number };

    expect(secondResult.total).toBe(2);
    expect(secondResult.summary).toContain("₹350");
  });

  it("preserves parser and query problems for ragged rows and invalid column operations", async () => {
    sourceTextMap.set("case-1:turn-1", "ColA,ColB\nValA\nVal1,Val2,Val3\n");

    const parseResult = (await invoke(IPC_CHANNELS.workstationTableParse, {
      caseId: "case-1",
      sourceTurnId: "turn-1"
    })) as { readonly problems: readonly string[] };

    expect(parseResult.problems.length).toBeGreaterThan(0);
    expect(parseResult.problems.some((p) => p.includes("padded") || p.includes("trimmed"))).toBe(true);

    const queryResult = (await invoke(IPC_CHANNELS.workstationTableQuery, {
      caseId: "case-1",
      sourceTurnId: "turn-1",
      spec: {
        filters: [{ column: 99, op: "is", value: "test" }]
      }
    })) as { readonly problems: readonly string[] };

    expect(queryResult.problems.length).toBeGreaterThan(0);
    expect(queryResult.problems.some((p) => p.includes("Column 99 does not exist"))).toBe(true);
  });

  it("enforces single in-flight operation and refuses concurrent calls", async () => {
    let finishFirst: () => void = () => {};
    mockSourceText.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishFirst = () => resolve("ColA,ColB\nA1,B1\n");
        })
    );

    const firstPromise = invoke(IPC_CHANNELS.workstationTableParse, {
      caseId: "case-1",
      sourceTurnId: "turn-1"
    });

    await expect(
      invoke(IPC_CHANNELS.workstationTableQuery, {
        caseId: "case-1",
        sourceTurnId: "turn-1",
        spec: { filters: [] }
      })
    ).rejects.toThrow("already running");

    finishFirst();
    await firstPromise;
  });

  it("rejects when window changes mid-operation", async () => {
    sourceTextMap.set("case-1:turn-1", "Item,Price\nBook,50\n");

    let finishSource: () => void = () => {};
    mockSourceText.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishSource = () => resolve("Item,Price\nBook,50\n");
        })
    );

    const queryPromise = invoke(IPC_CHANNELS.workstationTableQuery, {
      caseId: "case-1",
      sourceTurnId: "turn-1",
      spec: { filters: [] }
    });

    (event as { senderFrame: unknown }).senderFrame = {} as unknown as typeof event.senderFrame;

    finishSource();

    await expect(queryPromise).rejects.toThrow("This window changed");
  });
});
