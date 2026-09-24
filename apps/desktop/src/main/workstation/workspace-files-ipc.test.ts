import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { MAX_PREVIEW_BYTES } from "./workspace-files.js";
import { MAX_DIFF_LINES } from "./file-change.js";
import { installWorkstationFiles } from "./workspace-files-ipc.js";

const f = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
}));

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/synthetic/desktop" },
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) => {
      f.handlers.set(name, handler);
    }
  }
}));


/**
 * Waits until the handler has actually reached the stub.
 *
 * The resolver is only assigned when the mock is called, and the handler gets
 * there asynchronously — releasing it straight after `invoke` fires the no-op
 * default and the promise never settles, so the test hangs to its timeout
 * instead of failing with a reason. Same for an in-flight guard: asking for a
 * second operation before the first has reached the stub races it.
 */
/** The stub this suite releases has been reached. */
async function untilStubReached(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

async function untilCalled(mock: { readonly mock: { readonly calls: readonly unknown[] } }): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (mock.mock.calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The handler never reached the stub.");
}

describe("Workspace files IPC", () => {
  let tempWorkspaceDir: string;
  let outsideDir: string;
  let caseId: string;
  let event: IpcMainInvokeEvent;
  let sender: EventEmitter;
  let senderFrame: object;
  let trusted: boolean;
  let workspacePath: string | null;
  const mockReadFile = vi.fn();

  const invoke = (channel: string, input: unknown) => {
    const handler = f.handlers.get(channel);
    if (!handler) {
      throw new Error(`Handler for channel ${channel} was not registered`);
    }
    return Promise.resolve().then(() => handler(event, input));
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    f.handlers.clear();
    trusted = true;
    caseId = "case-alpha";

    const rawWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "rellane-ws-"));
    tempWorkspaceDir = await fs.realpath(rawWorkspace);

    const rawOutside = await fs.mkdtemp(path.join(os.tmpdir(), "rellane-out-"));
    outsideDir = await fs.realpath(rawOutside);

    workspacePath = tempWorkspaceDir;

    sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    senderFrame = {};
    event = { sender, senderFrame } as unknown as IpcMainInvokeEvent;

    mockReadFile.mockImplementation(async (filePath: string) => {
      return fs.readFile(filePath, "utf8");
    });

    installWorkstationFiles({
      assertTrusted: () => {
        if (!trusted) throw new Error("Untrusted sender");
      },
      workspaceFor: async (id: string) => (id === caseId ? workspacePath : null),
      readFile: mockReadFile
    });
  });

  afterEach(async () => {
    await fs.rm(tempWorkspaceDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {});
  });

  it("rejects untrusted sender before any work is performed", async () => {
    trusted = false;

    await expect(
      invoke(IPC_CHANNELS.workstationFilesList, { caseId })
    ).rejects.toThrow("Untrusted sender");

    await expect(
      invoke(IPC_CHANNELS.workstationFilePreview, { caseId, relativePath: "notes.txt" })
    ).rejects.toThrow("Untrusted sender");

    await expect(
      invoke(IPC_CHANNELS.workstationFileChange, {
        caseId,
        relativePath: "notes.txt",
        previousText: "Initial"
      })
    ).rejects.toThrow("Untrusted sender");

    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("refuses cases that have no workspace folder configured", async () => {
    workspacePath = null;

    await expect(
      invoke(IPC_CHANNELS.workstationFilesList, { caseId })
    ).rejects.toThrow("This work has no workspace folder.");

    await expect(
      invoke(IPC_CHANNELS.workstationFilePreview, { caseId, relativePath: "notes.txt" })
    ).rejects.toThrow("This work has no workspace folder.");

    await expect(
      invoke(IPC_CHANNELS.workstationFileChange, {
        caseId,
        relativePath: "notes.txt",
        previousText: "Initial"
      })
    ).rejects.toThrow("This work has no workspace folder.");
  });

  it("prevents relative paths with .. from escaping the workspace root", async () => {
    const outsideFile = path.join(outsideDir, "secret.txt");
    await fs.writeFile(outsideFile, "confidential", "utf8");

    const previewResult = (await invoke(IPC_CHANNELS.workstationFilePreview, {
      caseId,
      relativePath: "../" + path.basename(outsideDir) + "/secret.txt"
    })) as { readonly status: string; readonly reason?: string };

    expect(previewResult.status).toBe("unavailable");
    expect(previewResult.reason).toContain("outside the workspace");

    await expect(
      invoke(IPC_CHANNELS.workstationFileChange, {
        caseId,
        relativePath: "../" + path.basename(outsideDir) + "/secret.txt",
        previousText: "old"
      })
    ).rejects.toThrow("The requested path is outside the workspace.");
  });

  it("prevents symlinks from escaping the workspace root after resolution", async () => {
    const outsideTarget = path.join(outsideDir, "credentials.env");
    await fs.writeFile(outsideTarget, "TOKEN=supersecret", "utf8");

    const linkPath = path.join(tempWorkspaceDir, "linked-creds.env");
    await fs.symlink(outsideTarget, linkPath);

    const previewResult = (await invoke(IPC_CHANNELS.workstationFilePreview, {
      caseId,
      relativePath: "linked-creds.env"
    })) as { readonly status: string; readonly reason?: string };

    expect(previewResult.status).toBe("unavailable");
    expect(previewResult.reason).toContain("links outside the workspace");

    await expect(
      invoke(IPC_CHANNELS.workstationFileChange, {
        caseId,
        relativePath: "linked-creds.env",
        previousText: ""
      })
    ).rejects.toThrow("The requested file links outside the workspace.");
  });

  it("returns missing kind rather than throwing when the requested file is gone", async () => {
    const changeResult = (await invoke(IPC_CHANNELS.workstationFileChange, {
      caseId,
      relativePath: "missing-document.ts",
      previousText: "const prior = 42;"
    })) as { readonly kind: string; readonly summary: string; readonly relativePath: string };

    expect(changeResult.kind).toBe("missing");
    expect(changeResult.relativePath).toBe("missing-document.ts");
    expect(changeResult.summary).toBe("This file could not be found.");
  });

  it("reports binary files as binary and does not preview them as text", async () => {
    const binaryPath = path.join(tempWorkspaceDir, "blob.bin");
    await fs.writeFile(binaryPath, Buffer.from([0x00, 0x01, 0xff, 0x00, 0x5a]));

    const previewResult = (await invoke(IPC_CHANNELS.workstationFilePreview, {
      caseId,
      relativePath: "blob.bin"
    })) as { readonly status: string; readonly reason?: string };

    expect(previewResult.status).toBe("unavailable");
    expect(previewResult.reason).toContain("binary");

    const changeResult = (await invoke(IPC_CHANNELS.workstationFileChange, {
      caseId,
      relativePath: "blob.bin",
      previousText: "normal text"
    })) as { readonly kind: string; readonly summary: string };

    expect(changeResult.kind).toBe("binary");
    expect(changeResult.summary).toBe("Binary file.");
  });

  it("respects preview size caps and caps diff line counts", async () => {
    const largeFilePath = path.join(tempWorkspaceDir, "huge.txt");
    const chunk = "A".repeat(1024) + "\n";
    const oversized = chunk.repeat(300);
    await fs.writeFile(largeFilePath, oversized, "utf8");

    const previewResult = (await invoke(IPC_CHANNELS.workstationFilePreview, {
      caseId,
      relativePath: "huge.txt"
    })) as { readonly status: string; readonly truncated: boolean; readonly bytes: number };

    expect(previewResult.status).toBe("text");
    expect(previewResult.truncated).toBe(true);
    expect(previewResult.bytes).toBeGreaterThan(MAX_PREVIEW_BYTES);

    const diffPath = path.join(tempWorkspaceDir, "diff-huge.txt");
    const diffLines = Array.from({ length: MAX_DIFF_LINES + 50 }, (_, i) => `line ${i}`).join("\n");
    await fs.writeFile(diffPath, diffLines, "utf8");

    const changeResult = (await invoke(IPC_CHANNELS.workstationFileChange, {
      caseId,
      relativePath: "diff-huge.txt",
      previousText: ""
    })) as { readonly kind: string; readonly truncated: boolean };

    expect(changeResult.kind).toBe("added");
    expect(changeResult.truncated).toBe(true);
  });

  it("lists workspace entries with kind, bytes and relative paths", async () => {
    await fs.mkdir(path.join(tempWorkspaceDir, "src"));
    await fs.writeFile(path.join(tempWorkspaceDir, "src", "index.ts"), "export const a = 1;", "utf8");

    const listResult = (await invoke(IPC_CHANNELS.workstationFilesList, {
      caseId
    })) as { readonly entries: readonly { readonly relativePath: string; readonly kind: string }[] };

    expect(listResult.entries.some((e) => e.relativePath === "src" && e.kind === "folder")).toBe(true);
    expect(listResult.entries.some((e) => e.relativePath === "src/index.ts" && e.kind === "file")).toBe(true);
  });

  it("enforces single in-flight change check at a time", async () => {
    const testFile = path.join(tempWorkspaceDir, "sample.txt");
    await fs.writeFile(testFile, "Current content", "utf8");

    let finishFirst: () => void = () => {};
    mockReadFile.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishFirst = () => resolve("Current content");
        })
    );

    const firstPromise = invoke(IPC_CHANNELS.workstationFileChange, {
      caseId,
      relativePath: "sample.txt",
      previousText: "Old content"
    });

    await expect(
      invoke(IPC_CHANNELS.workstationFileChange, {
        caseId,
        relativePath: "sample.txt",
        previousText: "Other content"
      })
    ).rejects.toThrow("A file change check is already running. Wait for it to finish.");

    await untilStubReached();

    finishFirst();
    await firstPromise;
  });

  it("enforces single in-flight preview at a time", async () => {
    const testFile = path.join(tempWorkspaceDir, "preview-slow.txt");
    await fs.writeFile(testFile, "Preview slow", "utf8");

    let finishFirst: () => void = () => {};
    const slowCaseId = "case-slow-preview";
    const slowWorkspaceFor = vi.fn().mockImplementation(async (id: string) => {
      if (id === slowCaseId) {
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
        return tempWorkspaceDir;
      }
      return id === caseId ? tempWorkspaceDir : null;
    });

    installWorkstationFiles({
      assertTrusted: () => {},
      workspaceFor: slowWorkspaceFor,
      readFile: mockReadFile
    });

    const firstPromise = invoke(IPC_CHANNELS.workstationFilePreview, {
      caseId: slowCaseId,
      relativePath: "preview-slow.txt"
    });

    await expect(
      invoke(IPC_CHANNELS.workstationFilePreview, {
        caseId: slowCaseId,
        relativePath: "preview-slow.txt"
      })
    ).rejects.toThrow("A file preview is already running. Wait for it to finish.");

    await untilStubReached();

    finishFirst();
    await firstPromise;
  });

  it("allows concurrent directory listings without blocking", async () => {
    await fs.writeFile(path.join(tempWorkspaceDir, "a.txt"), "A", "utf8");
    await fs.writeFile(path.join(tempWorkspaceDir, "b.txt"), "B", "utf8");

    const [listA, listB] = await Promise.all([
      invoke(IPC_CHANNELS.workstationFilesList, { caseId }),
      invoke(IPC_CHANNELS.workstationFilesList, { caseId })
    ]);

    expect(listA).toBeDefined();
    expect(listB).toBeDefined();
  });

  it("rejects when the window owner changes while reading files", async () => {
    const testFile = path.join(tempWorkspaceDir, "nav.txt");
    await fs.writeFile(testFile, "Navigation test", "utf8");

    mockReadFile.mockImplementationOnce(async () => {
      (event as { senderFrame: object }).senderFrame = {};
      return "Navigation test";
    });

    await expect(
      invoke(IPC_CHANNELS.workstationFileChange, {
        caseId,
        relativePath: "nav.txt",
        previousText: ""
      })
    ).rejects.toThrow("This window changed while checking file changes.");
  });

  it("computes accurate line diffs and hunks for modified files", async () => {
    const testFile = path.join(tempWorkspaceDir, "code.ts");
    await fs.writeFile(testFile, "line 1\nline 2 revised\nline 3\n", "utf8");

    const result = (await invoke(IPC_CHANNELS.workstationFileChange, {
      caseId,
      relativePath: "code.ts",
      previousText: "line 1\nline 2\nline 3\n"
    })) as {
      readonly kind: string;
      readonly added: number;
      readonly removed: number;
      readonly summary: string;
    };

    expect(result.kind).toBe("modified");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.summary).toBe("1 line added, 1 removed.");
  });
});
