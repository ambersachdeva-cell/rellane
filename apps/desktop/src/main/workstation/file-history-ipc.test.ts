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

function createTestOptions(
  overrides: Partial<InstallFileHistoryOptions> = {}
): InstallFileHistoryOptions {
  return {
    assertTrusted: overrides.assertTrusted ?? vi.fn(),
    folderFor: overrides.folderFor ?? vi.fn(async () => "/workspace/project"),
    snapshot: overrides.snapshot ?? vi.fn(async () => []),
    before: overrides.before ?? vi.fn(async () => []),
    contentBefore: overrides.contentBefore ?? vi.fn(async () => null),
    restore: overrides.restore ?? vi.fn(async () => {}),
    withAdmissionLease:
      overrides.withAdmissionLease ??
      vi.fn(async (_caseId, _folder, _owner, run) => run()),
    savePreimage: overrides.savePreimage ?? vi.fn(async () => true)
  };
}

describe("fileHistoryIpc", () => {
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

  it("fails closed when host admission refuses the restore", async () => {
    const restoreCalls: string[] = [];
    const throwingOptions = createTestOptions({
      contentBefore: vi.fn(async () => "saved text"),
      withAdmissionLease: vi.fn(async () => {
        throw new Error("Admission refused");
      }),
      restore: vi.fn(async () => {
        restoreCalls.push("thrown");
      })
    });
    installFileHistory(throwingOptions);
    const restoreHandler = handlers.get(IPC_CHANNELS.workstationChangeRestore);
    expect(restoreHandler).toBeDefined();

    const thrownResult = (await restoreHandler!(createFakeEvent(), {
      caseId: "case-1",
      operationId: "op-1",
      relativePath: "file.txt"
    })) as WorkstationChangeRestoreResult;

    expect(thrownResult.restored).toBe(false);
    expect(restoreCalls).toHaveLength(0);
  });

  it("refuses restore when a native run is active and admission callback refuses", async () => {
    const restoreCalls: string[] = [];
    const options = createTestOptions({
      contentBefore: vi.fn(async () => "saved text"),
      withAdmissionLease: vi.fn(async () => {
        throw new Error("Stop the workstation session before closing or erasing this case.");
      }),
      restore: vi.fn(async () => {
        restoreCalls.push("active-run");
      })
    });
    installFileHistory(options);

    const restoreHandler = handlers.get(IPC_CHANNELS.workstationChangeRestore);
    expect(restoreHandler).toBeDefined();

    const result = (await restoreHandler!(createFakeEvent(), {
      caseId: "case-active",
      operationId: "op-active",
      relativePath: "file.txt"
    })) as WorkstationChangeRestoreResult;

    expect(result.restored).toBe(false);
    expect(restoreCalls).toHaveLength(0);
  });

  it("refuses restore when durable preimage returns false or throws", async () => {
    const restoreCalls: string[] = [];
    const falsePreimageOptions = createTestOptions({
      contentBefore: vi.fn(async () => "saved text"),
      savePreimage: vi.fn(async () => false),
      restore: vi.fn(async () => {
        restoreCalls.push("preimage-false");
      })
    });
    installFileHistory(falsePreimageOptions);

    const restoreHandler = handlers.get(IPC_CHANNELS.workstationChangeRestore);
    expect(restoreHandler).toBeDefined();

    const falseResult = (await restoreHandler!(createFakeEvent(), {
      caseId: "case-1",
      operationId: "op-1",
      relativePath: "target.txt"
    })) as WorkstationChangeRestoreResult;

    expect(falseResult.restored).toBe(false);
    expect(falseResult.restoreOperationId).toBeUndefined();
    expect(restoreCalls).toHaveLength(0);

    const throwingPreimageOptions = createTestOptions({
      contentBefore: vi.fn(async () => "saved text"),
      savePreimage: vi.fn(async () => {
        throw new Error("Durable disk snapshot failed");
      }),
      restore: vi.fn(async () => {
        restoreCalls.push("preimage-throw");
      })
    });
    installFileHistory(throwingPreimageOptions);

    const throwResult = (await restoreHandler!(createFakeEvent(), {
      caseId: "case-1",
      operationId: "op-1",
      relativePath: "target.txt"
    })) as WorkstationChangeRestoreResult;

    expect(throwResult.restored).toBe(false);
    expect(throwResult.restoreOperationId).toBeUndefined();
    expect(restoreCalls).toHaveLength(0);
  });

  it("enforces strict execution order lock -> preimage -> restore", async () => {
    const stepOrder: string[] = [];
    const options = createTestOptions({
      contentBefore: vi.fn(async () => "saved text"),
      withAdmissionLease: vi.fn(async (_caseId, _folder, _owner, run) => {
        stepOrder.push("lock");
        return run();
      }),
      savePreimage: vi.fn(async () => {
        stepOrder.push("preimage");
        return true;
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
    expect(stepOrder).toEqual(["lock", "preimage", "restore"]);
  });

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

  it("prevents overlapping concurrent restores through host lease", async () => {
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let notifyFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });

    const options = createTestOptions({
      contentBefore: vi.fn(async () => "saved file text"),
      withAdmissionLease: vi.fn(async (_caseId, _folder, _owner, run) => {
        notifyFirstStarted();
        await firstHeld;
        return run();
      })
    });
    installFileHistory(options);

    const restoreHandler = handlers.get(IPC_CHANNELS.workstationChangeRestore);
    expect(restoreHandler).toBeDefined();

    const firstPromise = restoreHandler!(createFakeEvent(), {
      caseId: "case-1",
      operationId: "op-1",
      relativePath: "file1.txt"
    }) as Promise<WorkstationChangeRestoreResult>;

    await firstStarted;

    const secondResult = (await restoreHandler!(createFakeEvent(), {
      caseId: "case-1",
      operationId: "op-1",
      relativePath: "file2.txt"
    })) as WorkstationChangeRestoreResult;

    expect(secondResult.restored).toBe(false);

    releaseFirst();
    const firstResult = await firstPromise;
    expect(firstResult.restored).toBe(true);
  });

  it("blocks restore when folder changes during preimage and reports truthful receipt", async () => {
    let folderLocation = "/workspace/project";
    const restoreCalls: string[] = [];

    const options = createTestOptions({
      folderFor: vi.fn(async () => folderLocation),
      contentBefore: vi.fn(async () => "original text"),
      savePreimage: vi.fn(async () => {
        folderLocation = "/workspace/diverted";
        return true;
      }),
      restore: vi.fn(async () => {
        restoreCalls.push("should-not-run");
      })
    });
    installFileHistory(options);

    const restoreHandler = handlers.get(IPC_CHANNELS.workstationChangeRestore);
    expect(restoreHandler).toBeDefined();

    const result = (await restoreHandler!(createFakeEvent(), {
      caseId: "case-1",
      operationId: "op-1",
      relativePath: "file.txt"
    })) as WorkstationChangeRestoreResult;

    expect(result.restored).toBe(false);
    expect(restoreCalls).toHaveLength(0);
    expect(result.restoreOperationId).toBeDefined();
    expect(typeof result.restoreOperationId).toBe("string");
  });

  it("blocks restore when window owner changes during preimage and reports truthful receipt", async () => {
    const restoreCalls: string[] = [];
    const fakeEvent = createFakeEvent();

    const options = createTestOptions({
      contentBefore: vi.fn(async () => "original text"),
      savePreimage: vi.fn(async () => {
        (fakeEvent as { sender: { id: number; isDestroyed: () => boolean } }).sender = {
          id: 999,
          isDestroyed: () => false
        };
        return true;
      }),
      restore: vi.fn(async () => {
        restoreCalls.push("should-not-run");
      })
    });
    installFileHistory(options);

    const restoreHandler = handlers.get(IPC_CHANNELS.workstationChangeRestore);
    expect(restoreHandler).toBeDefined();

    const result = (await restoreHandler!(fakeEvent, {
      caseId: "case-1",
      operationId: "op-1",
      relativePath: "file.txt"
    })) as WorkstationChangeRestoreResult;

    expect(result.restored).toBe(false);
    expect(restoreCalls).toHaveLength(0);
    expect(result.restoreOperationId).toBeDefined();
  });

  it("records truthful restore when window owner is lost during completed write", async () => {
    let persistedId: string | null = null;
    let writeRecord: { folder: string; relativePath: string; contents: string } | null = null;
    const fakeEvent = createFakeEvent();

    const options = createTestOptions({
      contentBefore: vi.fn(async () => "original text"),
      savePreimage: vi.fn(async (_caseId, restoreOpId) => {
        persistedId = restoreOpId;
        return true;
      }),
      restore: vi.fn(async (folder, relativePath, contents) => {
        writeRecord = { folder, relativePath, contents };
        (fakeEvent as { sender: { id: number; isDestroyed: () => boolean } }).sender = {
          id: 999,
          isDestroyed: () => true
        };
      })
    });
    installFileHistory(options);

    const restoreHandler = handlers.get(IPC_CHANNELS.workstationChangeRestore);
    expect(restoreHandler).toBeDefined();

    const result = (await restoreHandler!(fakeEvent, {
      caseId: "case-1",
      operationId: "op-1",
      relativePath: "file.txt"
    })) as WorkstationChangeRestoreResult;

    expect(result.restored).toBe(true);
    expect(result.restoreOperationId).toBe(persistedId);
    expect(result.preimageOperationId).toBe(persistedId);
    expect(writeRecord).toEqual({
      folder: "/workspace/project",
      relativePath: "file.txt",
      contents: "original text"
    });
  });

  it("records truthful restore when folder location changes after completed write", async () => {
    let persistedId: string | null = null;
    let currentFolder = "/workspace/project";

    const options = createTestOptions({
      folderFor: vi.fn(async () => currentFolder),
      contentBefore: vi.fn(async () => "original text"),
      savePreimage: vi.fn(async (_caseId, restoreOpId) => {
        persistedId = restoreOpId;
        return true;
      }),
      restore: vi.fn(async () => {
        currentFolder = "/workspace/diverted";
      })
    });
    installFileHistory(options);

    const restoreHandler = handlers.get(IPC_CHANNELS.workstationChangeRestore);
    expect(restoreHandler).toBeDefined();

    const result = (await restoreHandler!(createFakeEvent(), {
      caseId: "case-1",
      operationId: "op-1",
      relativePath: "file.txt"
    })) as WorkstationChangeRestoreResult;

    expect(result.restored).toBe(true);
    expect(result.restoreOperationId).toBe(persistedId);
    expect(result.preimageOperationId).toBe(persistedId);
  });

  it("never reports restored when writing fails, while exposing preimage operation ID and uncertain receipt", async () => {
    let persistedId: string | null = null;
    const options = createTestOptions({
      contentBefore: vi.fn(async () => "original text"),
      savePreimage: vi.fn(async (_caseId, restoreOpId) => {
        persistedId = restoreOpId;
        return true;
      }),
      restore: vi.fn(async () => {
        throw new Error("ENOSPC: no space left on device");
      })
    });
    installFileHistory(options);

    const restoreHandler = handlers.get(IPC_CHANNELS.workstationChangeRestore);
    expect(restoreHandler).toBeDefined();

    const result = (await restoreHandler!(createFakeEvent(), {
      caseId: "case-1",
      operationId: "op-1",
      relativePath: "file.txt"
    })) as WorkstationChangeRestoreResult;

    expect(result.restored).toBe(false);
    expect(result.uncertain).toBe(true);
    expect(result.restoreOperationId).toBe(persistedId);
    expect(result.preimageOperationId).toBe(persistedId);
  });

  it("generates a fresh preimage operation ID distinct from the source operationId", async () => {
    let capturedPreimageId: string | null = null;
    const options = createTestOptions({
      contentBefore: vi.fn(async () => "original text"),
      savePreimage: vi.fn(async (_caseId, restoreOpId) => {
        capturedPreimageId = restoreOpId;
        return true;
      })
    });
    installFileHistory(options);

    const restoreHandler = handlers.get(IPC_CHANNELS.workstationChangeRestore);
    expect(restoreHandler).toBeDefined();

    const result = (await restoreHandler!(createFakeEvent(), {
      caseId: "case-1",
      operationId: "op-100",
      relativePath: "file.txt"
    })) as WorkstationChangeRestoreResult;

    expect(result.restored).toBe(true);
    expect(capturedPreimageId).toBeDefined();
    expect(typeof capturedPreimageId).toBe("string");
    expect(capturedPreimageId).not.toBe("op-100");
    expect(result.restoreOperationId).toBe(capturedPreimageId);
  });

  it("returns truthful receipt upon successful restore", async () => {
    let writeRecord: { folder: string; relativePath: string; contents: string } | null = null;
    let preimageIdPassed: string | null = null;

    const options = createTestOptions({
      contentBefore: vi.fn(async () => "saved file contents"),
      savePreimage: vi.fn(async (_caseId, restoreOpId) => {
        preimageIdPassed = restoreOpId;
        return true;
      }),
      restore: vi.fn(async (folder, relativePath, contents) => {
        writeRecord = { folder, relativePath, contents };
      })
    });
    installFileHistory(options);

    const restoreHandler = handlers.get(IPC_CHANNELS.workstationChangeRestore);
    expect(restoreHandler).toBeDefined();

    const result = (await restoreHandler!(createFakeEvent(), {
      caseId: "case-success",
      operationId: "op-initial",
      relativePath: "src/file.ts"
    })) as WorkstationChangeRestoreResult;

    expect(result.restored).toBe(true);
    expect(result.restoreOperationId).toBe(preimageIdPassed);
    expect(writeRecord).toEqual({
      folder: "/workspace/project",
      relativePath: "src/file.ts",
      contents: "saved file contents"
    });
  });

  it("passes caseId, folder, and owner to admission lease callback", async () => {
    let capturedCaseId: string | null = null;
    let capturedFolder: string | null = null;
    let capturedOwner: unknown = null;
    const fakeEvent = createFakeEvent();

    const options = createTestOptions({
      contentBefore: vi.fn(async () => "saved file text"),
      withAdmissionLease: vi.fn(async (caseId, folder, owner, run) => {
        capturedCaseId = caseId;
        capturedFolder = folder;
        capturedOwner = owner;
        return run();
      })
    });
    installFileHistory(options);

    const restoreHandler = handlers.get(IPC_CHANNELS.workstationChangeRestore);
    expect(restoreHandler).toBeDefined();

    await restoreHandler!(fakeEvent, {
      caseId: "case-admission-test",
      operationId: "op-1",
      relativePath: "file.txt"
    });

    expect(capturedCaseId).toBe("case-admission-test");
    expect(capturedFolder).toBe("/workspace/project");
    expect(capturedOwner).toBe(fakeEvent.sender);
  });

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
