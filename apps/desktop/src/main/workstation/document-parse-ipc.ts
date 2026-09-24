import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";

/**
 * Maximum accepted file size for in-memory document parsing (64 MB).
 *
 * Files exceeding this threshold are refused before parsing to protect host memory
 * and keep the desktop application responsive for non-technical owners.
 */
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

/**
 * Maximum character length for document previews shown to the owner.
 *
 * Previews allow the owner to review what was read before committing
 * the document as a citable case source.
 */
export const MAX_PREVIEW_CHARS = 4_000;

export const WorkstationDocumentPickInputSchema = z.object({
  caseId: z.string().min(1)
});

export type WorkstationDocumentPickInput = z.infer<typeof WorkstationDocumentPickInputSchema>;

export interface DocumentHeading {
  readonly level: number;
  readonly text: string;
}

export interface DocumentPickParsedResult {
  readonly status: "parsed";
  readonly name: string;
  readonly format: string;
  readonly words: number;
  readonly preview: string;
  readonly headings: readonly DocumentHeading[];
  readonly warnings: readonly string[];
}

export interface DocumentPickCancelledResult {
  readonly status: "cancelled";
}

export interface DocumentPickUnreadableResult {
  readonly status: "unreadable";
  readonly reason: string;
}

export type DocumentPickResult =
  | DocumentPickParsedResult
  | DocumentPickCancelledResult
  | DocumentPickUnreadableResult;

export interface DocumentFormatDescriptor {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

export interface DocumentFormatsResult {
  readonly formats: readonly DocumentFormatDescriptor[];
}

/**
 * Formats described in plain, calm terms for a business owner rather than technical file extensions.
 */
export const SUPPORTED_DOCUMENT_FORMATS: readonly DocumentFormatDescriptor[] = [
  {
    id: "word",
    label: "A Word document",
    detail: "Microsoft Word documents with headings, paragraphs, and tables"
  },
  {
    id: "spreadsheet",
    label: "A spreadsheet export",
    detail: "Comma-separated or tab-separated tables from your accounts or spreadsheets"
  },
  {
    id: "pdf",
    label: "A PDF document",
    detail: "Reports, statements, and scanned documents saved as PDF"
  },
  {
    id: "web-page",
    label: "A web page you saved",
    detail: "HTML articles and pages saved from your browser"
  },
  {
    id: "markdown",
    label: "A Markdown note",
    detail: "Structured notes and drafts written in Markdown"
  },
  {
    id: "text",
    label: "A plain text file",
    detail: "Unformatted notes, logs, and text exports"
  },
  {
    id: "data-export",
    label: "A structured data export",
    detail: "Records and exports stored as JSON or JSON Lines"
  }
];

export interface InstallDocumentParseOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  /** Reads a file the owner picked. Returns its bytes and name. */
  readonly readPicked: (input: { readonly caseId: string }) => Promise<{
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly mimeType: string;
  } | null>;
  /** The parser. Its exact interface is quoted for you below. */
  readonly parse: (
    content: Uint8Array | string,
    options: { readonly filename: string; readonly mimeType: string }
  ) => {
    readonly format: string;
    readonly text: string;
    readonly headings: readonly { readonly level: number; readonly text: string }[];
    readonly warnings: readonly string[];
  };
}

/**
 * Counts words based on whitespace separation without relying on fragile regex splits on empty strings.
 */
export function countWords(text: string): number {
  const matches = text.match(/\S+/gu);
  return matches ? matches.length : 0;
}

/**
 * Converts byte counts into human-readable megabytes for owner-facing messages.
 */
export function formatBytesToPlainUnits(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  const rounded = Math.round(mb * 10) / 10;
  return `${rounded} MB`;
}

/**
 * Translates parser failures into calm, neutral sentences without exposing internal paths or stack traces.
 */
export function formatParseError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    const message = error.message.trim();
    if (!message.includes("\n") && !message.includes("/") && !message.includes("\\") && message.length < 200) {
      const cleanMessage = message.endsWith(".") ? message.slice(0, -1) : message;
      return `This file could not be read: ${cleanMessage}.`;
    }
  }
  return "This file could not be read. Please check that the file is not damaged or password-protected.";
}

export function installDocumentParse(options: InstallDocumentParseOptions): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);

  // Serialises native file picker interactions so overlapping requests cannot collide or leave orphaned state
  let isPicking = false;

  ipcMain.handle(
    IPC_CHANNELS.workstationDocumentPick,
    async (event, input: unknown): Promise<DocumentPickResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const parsedInput = WorkstationDocumentPickInputSchema.safeParse(
        typeof input === "string" ? { caseId: input } : input
      );
      if (!parsedInput.success) {
        return {
          status: "unreadable",
          reason: "A valid case identifier is required."
        };
      }
      const request = parsedInput.data;

      if (isPicking) {
        return {
          status: "unreadable",
          reason: "Another document is already being chosen. Please finish or cancel that selection first."
        };
      }

      isPicking = true;
      try {
        let picked: {
          readonly name: string;
          readonly bytes: Uint8Array;
          readonly mimeType: string;
        } | null;

        try {
          picked = await options.readPicked({ caseId: request.caseId });
        } catch {
          // File reading may fail if a selected file is moved, unmounted, or permissions are revoked
          return {
            status: "unreadable",
            reason: "This file could not be opened. It may have been moved, deleted, or permissions were denied."
          };
        }

        // Validate that the renderer frame remains authentic and has not navigated away during file selection
        options.assertTrusted(event);
        if (ownerFor(event) !== owner) {
          throw new Error("This window changed while choosing the document.");
        }

        if (picked === null) {
          return { status: "cancelled" };
        }

        if (picked.bytes.byteLength > MAX_DOCUMENT_BYTES) {
          return {
            status: "unreadable",
            reason: `This file is ${formatBytesToPlainUnits(picked.bytes.byteLength)}, which exceeds the 64 MB limit. Please choose a smaller file.`
          };
        }

        try {
          const parsed = options.parse(picked.bytes, {
            filename: picked.name,
            mimeType: picked.mimeType
          });

          return {
            status: "parsed",
            name: picked.name,
            format: parsed.format,
            words: countWords(parsed.text),
            preview: parsed.text.slice(0, MAX_PREVIEW_CHARS),
            headings: parsed.headings,
            warnings: parsed.warnings
          };
        } catch (error) {
          return {
            status: "unreadable",
            reason: formatParseError(error)
          };
        }
      } finally {
        isPicking = false;
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationDocumentFormats,
    async (event): Promise<DocumentFormatsResult> => {
      options.assertTrusted(event);
      return { formats: SUPPORTED_DOCUMENT_FORMATS };
    }
  );
}
