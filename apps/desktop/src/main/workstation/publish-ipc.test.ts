import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  installPublish,
  type InstallPublishOptions,
  type PublishPreviewResult,
  type PublishWriteResult
} from "./publish-ipc.js";
import { publishOutput } from "./publish-output.js";

type IpcHandler = (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>;

const handlers = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    })
  }
}));

vi.mock("./publish-output.js", () => ({
  publishOutput: vi.fn()
}));

describe("publish-ipc", () => {
  // The owner registry calls `isDestroyed()` and subscribes to navigation, so a
  // plain object throws before the handler under test is ever reached.
  const mockSender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false });
  const mockFrame = { id: 1 };
  const mockEvent = {
    sender: mockSender,
    senderFrame: mockFrame
  } as unknown as IpcMainInvokeEvent;

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  it("returns file summaries and byte counts during preview without touching write", async () => {
    const writeMock = vi.fn().mockResolvedValue("/cases/case-1");
    const mockOutput = {
      title: "Quarterly Summary",
      body: "All metrics up.",
      sources: [{ label: "Financial Model" }]
    };

    vi.mocked(publishOutput).mockReturnValue({
      files: [
        { relativePath: "index.html", contents: "<h1>Quarterly Summary</h1>" },
        { relativePath: "styles.css", contents: "body { margin: 0; }" }
      ],
      summary: "Rendered HTML and styles",
      warnings: []
    });

    const options: InstallPublishOptions = {
      assertTrusted: vi.fn(),
      caseFolder: vi.fn().mockResolvedValue("/cases/case-1"),
      latestOutput: vi.fn().mockResolvedValue(mockOutput),
      write: writeMock
    };

    installPublish(options);

    const previewHandler = handlers.get(IPC_CHANNELS.workstationPublishPreview);
    expect(previewHandler).toBeDefined();
    if (!previewHandler) {
      throw new Error("Preview handler must be registered");
    }

    const result = (await previewHandler(mockEvent, {
      caseId: "case-1",
      format: "html"
    })) as PublishPreviewResult;

    expect(writeMock).not.toHaveBeenCalled();
    expect(result.summary).toBe("Rendered HTML and styles");
    expect(result.warnings).toEqual([]);
    // Counted from the fixture rather than written down, so the assertion cannot
    // drift from the strings it is about.
    expect(result.files).toEqual([
      { relativePath: "index.html", bytes: Buffer.byteLength("<h1>Quarterly Summary</h1>", "utf8") },
      { relativePath: "styles.css", bytes: Buffer.byteLength("body { margin: 0; }", "utf8") }
    ]);
  });

  it("refuses a case with no saved output on preview", async () => {
    const writeMock = vi.fn().mockResolvedValue("/cases/case-1");
    const options: InstallPublishOptions = {
      assertTrusted: vi.fn(),
      caseFolder: vi.fn().mockResolvedValue("/cases/case-1"),
      latestOutput: vi.fn().mockResolvedValue(null),
      write: writeMock
    };

    installPublish(options);

    const previewHandler = handlers.get(IPC_CHANNELS.workstationPublishPreview);
    expect(previewHandler).toBeDefined();
    if (!previewHandler) {
      throw new Error("Preview handler must be registered");
    }

    await expect(
      previewHandler(mockEvent, { caseId: "case-1", format: "html" })
    ).rejects.toThrow("This case has no saved output to publish.");
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("refuses a case with no saved output on write", async () => {
    const writeMock = vi.fn().mockResolvedValue("/cases/case-1");
    const options: InstallPublishOptions = {
      assertTrusted: vi.fn(),
      caseFolder: vi.fn().mockResolvedValue("/cases/case-1"),
      latestOutput: vi.fn().mockResolvedValue(null),
      write: writeMock
    };

    installPublish(options);

    const writeHandler = handlers.get(IPC_CHANNELS.workstationPublishWrite);
    expect(writeHandler).toBeDefined();
    if (!writeHandler) {
      throw new Error("Write handler must be registered");
    }

    await expect(
      writeHandler(mockEvent, { caseId: "case-1", format: "html" })
    ).rejects.toThrow("This case has no saved output to publish.");
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("refuses to write when the case has no destination folder", async () => {
    const writeMock = vi.fn().mockResolvedValue("/cases/case-1");
    const options: InstallPublishOptions = {
      assertTrusted: vi.fn(),
      caseFolder: vi.fn().mockResolvedValue(null),
      latestOutput: vi.fn().mockResolvedValue({
        title: "Title",
        body: "Body",
        sources: []
      }),
      write: writeMock
    };

    installPublish(options);

    const writeHandler = handlers.get(IPC_CHANNELS.workstationPublishWrite);
    expect(writeHandler).toBeDefined();
    if (!writeHandler) {
      throw new Error("Write handler must be registered");
    }

    await expect(
      writeHandler(mockEvent, { caseId: "case-1", format: "markdown" })
    ).rejects.toThrow("This case does not have a folder to write into.");
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("refuses to write and writes nothing when a relative path escapes the destination folder", async () => {
    const writeMock = vi.fn().mockResolvedValue("/cases/case-1");
    vi.mocked(publishOutput).mockReturnValue({
      files: [
        { relativePath: "../escaped.txt", contents: "escape payload" }
      ],
      summary: "Escaped file",
      warnings: []
    });

    const options: InstallPublishOptions = {
      assertTrusted: vi.fn(),
      caseFolder: vi.fn().mockResolvedValue("/cases/case-1"),
      latestOutput: vi.fn().mockResolvedValue({
        title: "Title",
        body: "Body",
        sources: []
      }),
      write: writeMock
    };

    installPublish(options);

    const writeHandler = handlers.get(IPC_CHANNELS.workstationPublishWrite);
    expect(writeHandler).toBeDefined();
    if (!writeHandler) {
      throw new Error("Write handler must be registered");
    }

    await expect(
      writeHandler(mockEvent, { caseId: "case-1", format: "slides" })
    ).rejects.toThrow("A published file path falls outside the destination folder.");

    expect(writeMock).not.toHaveBeenCalled();
  });

  it("refuses a second concurrent write while one is in progress", async () => {
    let completeFirstWrite: ((folder: string) => void) | undefined;
    const firstWritePromise = new Promise<string>((resolve) => {
      completeFirstWrite = resolve;
    });

    const writeMock = vi.fn().mockImplementation(() => firstWritePromise);

    vi.mocked(publishOutput).mockReturnValue({
      files: [{ relativePath: "summary.md", contents: "# Summary" }],
      summary: "Markdown output",
      warnings: []
    });

    const options: InstallPublishOptions = {
      assertTrusted: vi.fn(),
      caseFolder: vi.fn().mockResolvedValue("/cases/case-1"),
      latestOutput: vi.fn().mockResolvedValue({
        title: "Title",
        body: "Body",
        sources: []
      }),
      write: writeMock
    };

    installPublish(options);

    const writeHandler = handlers.get(IPC_CHANNELS.workstationPublishWrite);
    expect(writeHandler).toBeDefined();
    if (!writeHandler) {
      throw new Error("Write handler must be registered");
    }

    const firstWriteCall = writeHandler(mockEvent, {
      caseId: "case-1",
      format: "markdown"
    });

    await expect(
      writeHandler(mockEvent, {
        caseId: "case-1",
        format: "markdown"
      })
    ).rejects.toThrow("Another publish is already in progress.");

    if (!completeFirstWrite) {
      throw new Error("Resolver must be assigned");
    }
    completeFirstWrite("/cases/case-1");

    const firstResult = await firstWriteCall;
    expect(firstResult).toEqual({
      writtenTo: "/cases/case-1",
      summary: "Markdown output",
      warnings: [],
      files: [{ relativePath: "summary.md", bytes: 9 }]
    });

    writeMock.mockResolvedValueOnce("/cases/case-1");
    const thirdResult = await writeHandler(mockEvent, {
      caseId: "case-1",
      format: "markdown"
    });
    expect(thirdResult).toBeDefined();
  });

  it("returns the destination folder reported by the write operation", async () => {
    const writeMock = vi.fn().mockResolvedValue("/cases/case-1/published");
    vi.mocked(publishOutput).mockReturnValue({
      files: [{ relativePath: "slides.html", contents: "<section>Slide</section>" }],
      summary: "Slide deck created",
      warnings: ["Single slide only"]
    });

    const options: InstallPublishOptions = {
      assertTrusted: vi.fn(),
      caseFolder: vi.fn().mockResolvedValue("/cases/case-1/published"),
      latestOutput: vi.fn().mockResolvedValue({
        title: "Slide Pitch",
        body: "Deck content",
        sources: []
      }),
      write: writeMock
    };

    installPublish(options);

    const writeHandler = handlers.get(IPC_CHANNELS.workstationPublishWrite);
    expect(writeHandler).toBeDefined();
    if (!writeHandler) {
      throw new Error("Write handler must be registered");
    }

    const result = (await writeHandler(mockEvent, {
      caseId: "case-1",
      format: "slides"
    })) as PublishWriteResult;

    expect(writeMock).toHaveBeenCalledWith("/cases/case-1/published", [
      { relativePath: "slides.html", contents: "<section>Slide</section>" }
    ]);
    expect(result.writtenTo).toBe("/cases/case-1/published");
    expect(result.summary).toBe("Slide deck created");
    expect(result.warnings).toEqual(["Single slide only"]);
    expect(result.files).toEqual([
      { relativePath: "slides.html", bytes: Buffer.byteLength("<section>Slide</section>", "utf8") }
    ]);
  });

  it("rejects unsupported publish formats", async () => {
    const options: InstallPublishOptions = {
      assertTrusted: vi.fn(),
      caseFolder: vi.fn().mockResolvedValue("/cases/case-1"),
      latestOutput: vi.fn().mockResolvedValue({
        title: "Title",
        body: "Body",
        sources: []
      }),
      write: vi.fn().mockResolvedValue("/cases/case-1")
    };

    installPublish(options);

    const previewHandler = handlers.get(IPC_CHANNELS.workstationPublishPreview);
    expect(previewHandler).toBeDefined();
    if (!previewHandler) {
      throw new Error("Preview handler must be registered");
    }

    await expect(
      previewHandler(mockEvent, { caseId: "case-1", format: "pdf" })
    ).rejects.toThrow();
  });

  it("renders Typst and themed multi-section publications via document-publisher", async () => {
    const writeMock = vi.fn().mockResolvedValue("/cases/case-1/published");
    const options: InstallPublishOptions = {
      assertTrusted: vi.fn(),
      caseFolder: vi.fn().mockResolvedValue("/cases/case-1/published"),
      latestOutput: vi.fn().mockResolvedValue({
        title: "Board Memo",
        body: "Key takeaways for Q3.",
        sources: [{ label: "Q3 Ledger" }]
      }),
      write: writeMock
    };

    installPublish(options);

    const previewHandler = handlers.get(IPC_CHANNELS.workstationPublishPreview)!;
    const preview = (await previewHandler(mockEvent, {
      caseId: "case-1",
      format: "typst",
      theme: "editorial",
      subtitle: "Confidential"
    })) as PublishPreviewResult;

    expect(preview.files).toHaveLength(1);
    expect(preview.files[0]!.relativePath).toBe("board-memo.typ");
    expect(preview.files[0]!.bytes).toBeGreaterThan(20);
  });
});
