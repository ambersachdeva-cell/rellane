import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  countWords,
  formatBytesToPlainUnits,
  formatParseError,
  installDocumentParse,
  type InstallDocumentParseOptions,
  type DocumentPickResult,
  type DocumentFormatsResult,
  MAX_DOCUMENT_BYTES,
  MAX_PREVIEW_CHARS,
  SUPPORTED_DOCUMENT_FORMATS
} from "./document-parse-ipc.js";

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown;

const registeredHandlers = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      registeredHandlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      registeredHandlers.delete(channel);
    })
  }
}));

let currentOwner: unknown = "owner-window-1";

vi.mock("../agents/source-owner.js", () => ({
  createAgentSourceOwners: () => () => currentOwner
}));

function createMockEvent(): IpcMainInvokeEvent {
  return {
    sender: {} as unknown as IpcMainInvokeEvent["sender"],
    senderFrame: {} as unknown as IpcMainInvokeEvent["senderFrame"]
  } as IpcMainInvokeEvent;
}

describe("document-parse-ipc", () => {
  beforeEach(() => {
    registeredHandlers.clear();
    currentOwner = "owner-window-1";
  });

  it("parses a small CSV through a stub and gets a preview and a word count", async () => {
    const csvContent = "Date,Item,Cost\n2025-01-01,Stationery,45\n2025-01-02,Software,120";
    const csvBytes = new TextEncoder().encode(csvContent);

    const options: InstallDocumentParseOptions = {
      assertTrusted: vi.fn(),
      readPicked: vi.fn(async () => ({
        name: "expenses.csv",
        bytes: csvBytes,
        mimeType: "text/csv"
      })),
      parse: vi.fn(() => ({
        format: "csv",
        text: "Date | Item | Cost\n2025-01-01 | Stationery | 45\n2025-01-02 | Software | 120",
        headings: [{ level: 1, text: "Expenses Summary" }],
        warnings: []
      }))
    };

    installDocumentParse(options);

    const handler = registeredHandlers.get(IPC_CHANNELS.workstationDocumentPick);
    expect(handler).toBeDefined();
    if (!handler) {
      throw new Error("Handler was not registered");
    }

    const result = (await handler(createMockEvent(), { caseId: "case-123" })) as DocumentPickResult;

    expect(result.status).toBe("parsed");
    if (result.status === "parsed") {
      expect(result.name).toBe("expenses.csv");
      expect(result.format).toBe("csv");
      // 15 whitespace-separated tokens: the pipes in this fixture are words too.
      expect(result.words).toBe(15);
      expect(result.preview).toContain("Date | Item | Cost");
      expect(result.headings).toEqual([{ level: 1, text: "Expenses Summary" }]);
      expect(result.warnings).toEqual([]);
    }
  });

  it("produces unreadable rather than a rejected promise when parser throws", async () => {
    const options: InstallDocumentParseOptions = {
      assertTrusted: vi.fn(),
      readPicked: vi.fn(async () => ({
        name: "damaged.pdf",
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        mimeType: "application/pdf"
      })),
      parse: vi.fn(() => {
        throw new Error("Corrupted file structure");
      })
    };

    installDocumentParse(options);

    const handler = registeredHandlers.get(IPC_CHANNELS.workstationDocumentPick);
    expect(handler).toBeDefined();
    if (!handler) {
      throw new Error("Handler was not registered");
    }

    const result = (await handler(createMockEvent(), { caseId: "case-123" })) as DocumentPickResult;

    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") {
      expect(result.reason).toBe("This file could not be read: Corrupted file structure.");
    }
  });

  it("refuses a 100 MB payload without calling parse", async () => {
    const parseStub = vi.fn();
    const largeBytes = new Uint8Array(100 * 1024 * 1024);

    const options: InstallDocumentParseOptions = {
      assertTrusted: vi.fn(),
      readPicked: vi.fn(async () => ({
        name: "oversized-archive.pdf",
        bytes: largeBytes,
        mimeType: "application/pdf"
      })),
      parse: parseStub
    };

    installDocumentParse(options);

    const handler = registeredHandlers.get(IPC_CHANNELS.workstationDocumentPick);
    expect(handler).toBeDefined();
    if (!handler) {
      throw new Error("Handler was not registered");
    }

    const result = (await handler(createMockEvent(), { caseId: "case-123" })) as DocumentPickResult;

    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") {
      expect(result.reason).toContain("100 MB");
      expect(result.reason).toContain("64 MB");
    }
    expect(parseStub).not.toHaveBeenCalled();
  });

  it("returns cancelled when the owner cancels the file picker", async () => {
    const options: InstallDocumentParseOptions = {
      assertTrusted: vi.fn(),
      readPicked: vi.fn(async () => null),
      parse: vi.fn()
    };

    installDocumentParse(options);

    const handler = registeredHandlers.get(IPC_CHANNELS.workstationDocumentPick);
    expect(handler).toBeDefined();
    if (!handler) {
      throw new Error("Handler was not registered");
    }

    const result = (await handler(createMockEvent(), { caseId: "case-123" })) as DocumentPickResult;

    expect(result).toEqual({ status: "cancelled" });
  });

  it("refuses concurrent picks while one selection is already in progress", async () => {
    type Picked = { readonly name: string; readonly bytes: Uint8Array; readonly mimeType: string } | null;
    let resolveRead: ((value: Picked) => void) | undefined;

    const options: InstallDocumentParseOptions = {
      assertTrusted: vi.fn(),
      readPicked: vi.fn(
        (): Promise<Picked> =>
          new Promise<Picked>((resolve) => {
            resolveRead = resolve;
          })
      ),
      parse: vi.fn(() => ({
        format: "text",
        text: "Content",
        headings: [],
        warnings: []
      }))
    };

    installDocumentParse(options);

    const handler = registeredHandlers.get(IPC_CHANNELS.workstationDocumentPick);
    expect(handler).toBeDefined();
    if (!handler) {
      throw new Error("Handler was not registered");
    }

    const firstPickPromise = handler(createMockEvent(), { caseId: "case-1" });
    const secondPickPromise = handler(createMockEvent(), { caseId: "case-1" });

    const secondResult = (await secondPickPromise) as DocumentPickResult;
    expect(secondResult.status).toBe("unreadable");
    if (secondResult.status === "unreadable") {
      expect(secondResult.reason).toContain("Another document is already being chosen");
    }

    if (resolveRead) {
      resolveRead({
        name: "test.txt",
        bytes: new TextEncoder().encode("Content"),
        mimeType: "text/plain"
      });
    }

    const firstResult = (await firstPickPromise) as DocumentPickResult;
    expect(firstResult.status).toBe("parsed");
  });

  it("returns supported formats with friendly owner labels and no technical file extensions", async () => {
    const options: InstallDocumentParseOptions = {
      assertTrusted: vi.fn(),
      readPicked: vi.fn(),
      parse: vi.fn()
    };

    installDocumentParse(options);

    const handler = registeredHandlers.get(IPC_CHANNELS.workstationDocumentFormats);
    expect(handler).toBeDefined();
    if (!handler) {
      throw new Error("Handler was not registered");
    }

    const result = (await handler(createMockEvent())) as DocumentFormatsResult;
    expect(result.formats).toEqual(SUPPORTED_DOCUMENT_FORMATS);

    const labels = result.formats.map((f) => f.label);
    expect(labels).toContain("A Word document");
    expect(labels).toContain("A spreadsheet export");
    expect(labels).toContain("A web page you saved");

    for (const format of result.formats) {
      expect(format.label.toLowerCase()).not.toContain("docx");
      expect(format.label.toLowerCase()).not.toContain("csv");
      expect(format.label.toLowerCase()).not.toContain("html");
      expect(format.label).not.toContain("!");
      expect(format.detail).not.toContain("!");
      expect(format.label).not.toContain("—");
      expect(format.detail).not.toContain("—");
    }
  });

  it("throws when window navigation occurs while picking", async () => {
    const options: InstallDocumentParseOptions = {
      assertTrusted: vi.fn(),
      readPicked: vi.fn(async () => {
        currentOwner = "owner-window-2";
        return {
          name: "notes.txt",
          bytes: new TextEncoder().encode("notes"),
          mimeType: "text/plain"
        };
      }),
      parse: vi.fn()
    };

    installDocumentParse(options);

    const handler = registeredHandlers.get(IPC_CHANNELS.workstationDocumentPick);
    expect(handler).toBeDefined();
    if (!handler) {
      throw new Error("Handler was not registered");
    }

    await expect(handler(createMockEvent(), { caseId: "case-1" })).rejects.toThrow(
      "This window changed while choosing the document."
    );
  });

  it("handles filesystem failure during readPicked gracefully", async () => {
    const options: InstallDocumentParseOptions = {
      assertTrusted: vi.fn(),
      readPicked: vi.fn(async () => {
        throw new Error("ENOENT: file disappeared");
      }),
      parse: vi.fn()
    };

    installDocumentParse(options);

    const handler = registeredHandlers.get(IPC_CHANNELS.workstationDocumentPick);
    expect(handler).toBeDefined();
    if (!handler) {
      throw new Error("Handler was not registered");
    }

    const result = (await handler(createMockEvent(), { caseId: "case-1" })) as DocumentPickResult;
    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") {
      expect(result.reason).toContain("could not be opened");
    }
  });

  it("limits preview text to MAX_PREVIEW_CHARS", async () => {
    const longText = "a".repeat(10_000);
    const options: InstallDocumentParseOptions = {
      assertTrusted: vi.fn(),
      readPicked: vi.fn(async () => ({
        name: "long.txt",
        bytes: new TextEncoder().encode(longText),
        mimeType: "text/plain"
      })),
      parse: vi.fn(() => ({
        format: "text",
        text: longText,
        headings: [],
        warnings: []
      }))
    };

    installDocumentParse(options);

    const handler = registeredHandlers.get(IPC_CHANNELS.workstationDocumentPick);
    expect(handler).toBeDefined();
    if (!handler) {
      throw new Error("Handler was not registered");
    }

    const result = (await handler(createMockEvent(), { caseId: "case-1" })) as DocumentPickResult;
    expect(result.status).toBe("parsed");
    if (result.status === "parsed") {
      expect(result.preview.length).toBe(MAX_PREVIEW_CHARS);
    }
  });

  describe("utility functions", () => {
    it("counts words correctly across varied text forms", () => {
      expect(countWords("")).toBe(0);
      expect(countWords("   \n\t  ")).toBe(0);
      expect(countWords("one two three")).toBe(3);
      expect(countWords("  multiple   spaces  and\nnewlines  ")).toBe(4);
    });

    it("formats byte values into megabytes", () => {
      expect(formatBytesToPlainUnits(MAX_DOCUMENT_BYTES)).toBe("64 MB");
      expect(formatBytesToPlainUnits(100 * 1024 * 1024)).toBe("100 MB");
    });

    it("formats parse errors into calm sentences", () => {
      expect(formatParseError(new Error("Cannot unpack zip"))).toBe(
        "This file could not be read: Cannot unpack zip."
      );
      expect(formatParseError(new Error("Protected with password."))).toBe(
        "This file could not be read: Protected with password."
      );
      expect(formatParseError("not an error instance")).toBe(
        "This file could not be read. Please check that the file is not damaged or password-protected."
      );
      expect(formatParseError(new Error("Line 1\nLine 2\nStack trace"))).toBe(
        "This file could not be read. Please check that the file is not damaged or password-protected."
      );
    });
  });
});
