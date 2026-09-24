import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  installFileHistory,
  type InstallFileHistoryOptions,
  type WorkstationChangeContentsResult,
  type WorkstationChangeRestoreResult,
  type WorkstationChangesListResult
} from "./file-history-ipc.js";

type IpcHandler = (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>;

const handlers = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler): void => {
      handlers.set(channel, handler);
    }
  }
}));

vi.mock("../agents/source-owner.js", () => ({
  createAgentSourceOwners: () => (sender: unknown) => sender
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (filePath: string): Promise<string> => {
    if (filePath.endsWith("changed.txt")) {
      return "current disk contents";
    }
    const error = new Error("ENOENT: no such file or directory");
    throw error;
  })
}));

function createFakeEvent(): IpcMainInvokeEvent {
  return {
    sender: { id: 1, isDestroyed: () => false },
    senderFrame: { routingId: 1 }
  } as unknown as IpcMainInvokeEvent;
}

function createTestOptions(overrides: Partial<InstallFileHistoryOptions> = {}): InstallFileHistoryOptions {
  return {
    assertTrusted: overrides.assertTrusted ?? vi.fn(),
    folderFor: overrides.folderFor ?? vi.fn(async () => "/workspace/project"),
    snapshot: overrides.snapshot ?? vi.fn(async () => []),
    before: overrides.before ?? vi.fn(async () => []),
    contentBefore: overrides.contentBefore ?? vi.fn(async () => null),
    restore: overrides.restore ?? vi.fn(async () => {})
  };
}

describe("fileHistoryIpc", () => {
  // Proves traversal attempts like ../../etc/passwd restore nothing to the disk.
  it("refuses to restore a path that resolves outside the folder", async () => {
    const restoreCalls: string[] = [];
    const options = createTestOptions({
      restore: vi.fn(async (_folder, relativePath) => {
        restoreCalls.push(relativePath);
      })
    });
    installFileHistory(options);

    const restoreHandler = handlers.get(IPC_CHANNELS.workstationChangeRestore);
    expect(restoreHandler).toBeDefined();

    const result = (await restoreHandler!(createFakeEvent(), {
      caseId: "case-1",
      operationId: "op-1",
      relativePath: "../../etc/passwd"
    })) as WorkstationChangeRestoreResult;

    expect(result.restored).toBe(false);
    expect(restoreCalls).toHaveLength(0);
  });

  // When a removed file was not backed up before the session ran, restoration must be unavailable.
  it("reports canRestore as false for a removed file with no saved contents", async () => {
    const options = createTestOptions({
      before: vi.fn(async () => [
        { relativePath: "deleted-file.txt", hash: "hash-old" }
      ]),
      snapshot: vi.fn(async () => []),
      contentBefore: vi.fn(async () => null)
    });
    installFileHistory(options);

    const listHandler = handlers.get(IPC_CHANNELS.workstationChangesList);
    expect(listHandler).toBeDefined();

    const result = (await listHandler!(createFakeEvent(), {
      caseId: "case-1",
      operationId: "op-1"
    })) as WorkstationChangesListResult;

    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;
    expect(change.relativePath).toBe("deleted-file.txt");
    expect(change.kind).toBe("removed");
    expect(change.canRestore).toBe(false);
  });

  // Missing baseline snapshots from earlier versions must be presented as unknown rather than empty.
  it("distinguishes an unknown before state from an empty change list", async () => {
    const unknownOptions = createTestOptions({
      before: vi.fn(async () => null)
    });
    installFileHistory(unknownOptions);

    const listHandler = handlers.get(IPC_CHANNELS.workstationChangesList);
    expect(listHandler).toBeDefined();

    const unknownResult = (await listHandler!(createFakeEvent(), {
      caseId: "case-legacy",
      operationId: "op-legacy"
    })) as WorkstationChangesListResult;

    expect(unknownResult.folderKnown).toBe(true);
    expect(unknownResult.beforeKnown).toBe(false);
    expect(unknownResult.changes).toHaveLength(0);

    const knownOptions = createTestOptions({
      before: vi.fn(async () => [
        { relativePath: "unchanged.txt", hash: "same-hash" }
      ]),
      snapshot: vi.fn(async () => [
        { relativePath: "unchanged.txt", hash: "same-hash", bytes: 120, modifiedAt: 1700000000 }
      ])
    });
    installFileHistory(knownOptions);

    // The second install replaces the entry in the map; the handler captured
    // above is still bound to the first set of options.
    const secondListHandler = handlers.get(IPC_CHANNELS.workstationChangesList);
    expect(secondListHandler).toBeDefined();

    const knownResult = (await secondListHandler!(createFakeEvent(), {
      caseId: "case-current",
      operationId: "op-current"
    })) as WorkstationChangesListResult;

    expect(knownResult.folderKnown).toBe(true);
    expect(knownResult.beforeKnown).toBe(true);
    expect(knownResult.changes).toHaveLength(0);
  });

  // Undoing an undo requires capturing the current state on disk immediately before overwriting it.
  it("takes a snapshot before executing a restore", async () => {
    const stepOrder: string[] = [];
    const options = createTestOptions({
      contentBefore: vi.fn(async () => "original file text"),
      snapshot: vi.fn(async () => {
        stepOrder.push("snapshot");
        return [];
      }),
      restore: vi.fn(async () => {
        stepOrder.push("restore");
      })
    });
    installFileHistory(options);

    const restoreHandler = handlers.get(IPC_CHANNELS.workstationChangeRestore);
    expect(restoreHandler).toBeDefined();

    const result = (await restoreHandler!(createFakeEvent(), {
      caseId: "case-1",
      operationId: "op-1",
      relativePath: "src/index.ts"
    })) as WorkstationChangeRestoreResult;

    expect(result.restored).toBe(true);
    expect(stepOrder).toHaveLength(2);
    expect(stepOrder[0]!).toBe("snapshot");
    expect(stepOrder[1]!).toBe("restore");
  });

  // Two simultaneous writers in the same directory can corrupt files.
  it("refuses a restore while another operation is in progress for the same folder", async () => {
    let unblockFirstRestore: () => void = () => {};
    const firstRestoreStarted = new Promise<void>((res) => {
      unblockFirstRestore = res;
    });

    let completeFirstRestore: () => void = () => {};
    const firstRestoreRunning = new Promise<void>((res) => {
      completeFirstRestore = res;
    });

    const options = createTestOptions({
      contentBefore: vi.fn(async () => "saved file text"),
      restore: vi.fn(async () => {
        unblockFirstRestore();
        await firstRestoreRunning;
      })
    });
    installFileHistory(options);

    const restoreHandler = handlers.get(IPC_CHANNELS.workstationChangeRestore);
    expect(restoreHandler).toBeDefined();

    const firstCallPromise = restoreHandler!(createFakeEvent(), {
      caseId: "case-1",
      operationId: "op-1",
      relativePath: "first.txt"
    }) as Promise<WorkstationChangeRestoreResult>;

    await firstRestoreStarted;

    const secondResult = (await restoreHandler!(createFakeEvent(), {
      caseId: "case-1",
      operationId: "op-1",
      relativePath: "second.txt"
    })) as WorkstationChangeRestoreResult;

    expect(secondResult.restored).toBe(false);

    completeFirstRestore();
    const firstResult = await firstCallPromise;
    expect(firstResult.restored).toBe(true);
  });

  // Inspecting a change must return both versions without exposing paths outside the folder.
  it("reads before and after file contents safely", async () => {
    const options = createTestOptions({
      contentBefore: vi.fn(async () => "previous saved text")
    });
    installFileHistory(options);

    const contentsHandler = handlers.get(IPC_CHANNELS.workstationChangeContents);
    expect(contentsHandler).toBeDefined();

    const result = (await contentsHandler!(createFakeEvent(), {
      caseId: "case-1",
      operationId: "op-1",
      relativePath: "changed.txt"
    })) as WorkstationChangeContentsResult;

    expect(result.before).toBe("previous saved text");
    expect(result.after).toBe("current disk contents");

    const outsideResult = (await contentsHandler!(createFakeEvent(), {
      caseId: "case-1",
      operationId: "op-1",
      relativePath: "../../private.key"
    })) as WorkstationChangeContentsResult;

    expect(outsideResult.before).toBeNull();
    expect(outsideResult.after).toBeNull();
  });
});
