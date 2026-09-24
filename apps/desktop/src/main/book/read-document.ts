/** Reads an explicitly picked document using the bundled macOS helper.
 * Text-layer extraction and OCR can misread meaning; barcode detection does
 * not verify an issuer or signature. No document is uploaded or recorded here.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { app } from "electron";
import { diagnostics } from "../foundations/diagnostics.js";
import type { DocumentRead } from "@cadrane/contracts";
export type { DocumentRead } from "@cadrane/contracts";

const run = promisify(execFile);

/** Long enough for a ten-page PDF; short enough that a hang is not forever. */
export const READ_TIMEOUT_MS = 45_000;

/** Bigger than this is not a bill; it is a scan of a filing cabinet. */
export const MAX_BYTES = 40 * 1024 * 1024;

function helperPath(): string {
  // Packaged apps carry it in Resources; a dev run reads it out of the tree.
  return app.isPackaged
    ? join(process.resourcesPath, "read-document", "read-document")
    : join(app.getAppPath(), "..", "..", "native", "read-document", "read-document");
}

/**
 * Reads one file.
 *
 * Never throws: a bill that cannot be read is an answer with a reason, because
 * the person holding it can always type it and this is a shortcut rather than a
 * dependency.
 */
export async function readDocument(path: string, signal?: AbortSignal): Promise<DocumentRead> {
  const nothing = { ok: false, source: "none" as const, text: "", codes: [] };
  try {
    signal?.throwIfAborted();
    const { stdout } = await run(helperPath(), [path], {
      ...(signal ? { signal } : {}),
      timeout: READ_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      // Nothing from the environment: this reads a file and prints JSON, and a
      // helper that inherits the app's environment is a helper that can be
      // steered by one.
      env: { PATH: "/usr/bin:/bin" }
    });
    signal?.throwIfAborted();
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      source: DocumentRead["source"];
      text: string;
      codes: string[];
      problem?: string;
    };

    // The current helper labels images with any barcode as "qr", but its
    // text field is still OCR. Decoded barcode payloads are not bill text.
    const source = parsed.source === "qr" ? (parsed.text.trim() ? "ocr" : "none") : parsed.source;
    const ok = parsed.ok && parsed.text.trim().length > 0;
    diagnostics.info("book", "read a document", {
      // Never the path, never the contents, never the customer. This line
      // exists to show a read happened, in a log a person may hand over.
      source,
      characters: parsed.text.length,
      codes: parsed.codes.length
    });

    return {
      ok,
      source,
      text: parsed.text,
      codes: parsed.codes,
      said: ok
        ? sourceWords(source, parsed.codes.length)
        : (parsed.problem ??
          "Nothing readable was found in that file. You can still type the bill.")
    };
  } catch (error) {
    const why = error instanceof Error ? error.message : "";
    return {
      ...nothing,
      said: signal?.aborted ? "Document reading was stopped. Nothing was applied or saved."
        : why.includes("ENOENT")
        ? "The reader that opens photographs is missing from this build. Type the bill instead, and please send the diagnostics report."
        : why.includes("timed out") || why.includes("ETIMEDOUT")
          ? "That file took too long to read. A very large scan can do this — try one page."
          : "That file could not be read. You can still type the bill."
    };
  }
}

/** Extraction method is not proof of accuracy or authenticity. */
function sourceWords(source: DocumentRead["source"], codes: number): string {
  if (source === "qr") {
    return "Decoded from a barcode. Its issuer and signature have not been verified. Check the figures against the original bill.";
  }
  switch (source) {
    case "pdf-text":
      return "Extracted from the PDF text layer. Check reading order and figures against the original bill.";
    case "ocr":
      return "Read from the image with OCR. Characters and figures can be misread; check the original bill." + (codes > 0 ? " A barcode was also detected; its issuer and signature have not been verified." : "");
    default:
      return codes > 0 ? "A barcode was decoded; no authenticity check was made. Check the original bill." : "Read on this Mac. Check the original bill.";
  }
}
