/** A selected document becomes reviewable text, never executable content or a
 * live file grant. Read one bounded snapshot and never follow document links. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import JSZip from "jszip";
import { xml2js, type Element } from "xml-js";
import type { CaseSourcePreview } from "@cadrane/contracts";
import { parseDataTable } from "./data-table.js";

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_DOCX_BYTES = 4 * 1024 * 1024;
const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_CHARACTERS = 50_000;
export type SourceDocument = Omit<CaseSourcePreview, "token" | "expiresAt">;

function textFrom(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      "This file is not readable UTF-8 text. Export it as UTF-8 text or a Word document.",
    );
  }
}

async function wordText(bytes: Buffer): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error(
      "This Word file could not be opened. It may be damaged, encrypted or in an older format.",
    );
  }
  if (Object.keys(zip.files).length > 1_024)
    throw new Error("This Word file has too many parts to preview safely.");
  const entry = zip.file("word/document.xml");
  if (!entry)
    throw new Error(
      "This file does not contain a readable Word document body.",
    );
  const stream = entry.nodeStream() as Readable;
  const timeout = setTimeout(
    () =>
      stream.destroy(
        new Error("Word preview took too long. Try a smaller document."),
      ),
    5_000,
  );
  let xmlBytes: Buffer;
  try {
    xmlBytes = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      const fail = (message: string) => {
        failed = true;
        reject(new Error(message));
        stream.destroy();
      };
      stream.on("data", (chunk: unknown) => {
        if (failed) return;
        if (!Buffer.isBuffer(chunk)) {
          fail("Invalid Word document stream.");
          return;
        }
        size += chunk.length;
        if (size > MAX_XML_BYTES) {
          fail("The expanded Word body is too large to preview safely.");
          return;
        }
        chunks.push(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => {
        if (!failed) resolve(Buffer.concat(chunks, size));
      });
    });
  } finally {
    clearTimeout(timeout);
    stream.destroy();
  }
  const xml = textFrom(xmlBytes);
  if (/<!\s*(?:DOCTYPE|ENTITY)/iu.test(xml))
    throw new Error(
      "Word files with document type or entity declarations are not supported.",
    );
  let tree: Element;
  try {
    tree = xml2js(xml, {
      compact: false,
      ignoreDeclaration: true,
      ignoreInstruction: true,
      ignoreComment: true,
    }) as Element;
  } catch {
    throw new Error("The Word document body contains invalid XML.");
  }
  const document = tree.elements?.find((one) => one.name === "w:document");
  const namespace = document?.attributes?.["xmlns:w"];
  if (
    namespace !==
      "http://schemas.openxmlformats.org/wordprocessingml/2006/main" &&
    namespace !== "http://purl.oclc.org/ooxml/wordprocessingml/main"
  ) {
    throw new Error(
      "This Word document structure is not supported. Export its text instead.",
    );
  }
  const body = document?.elements?.find((one) => one.name === "w:body");
  if (!body) throw new Error("This Word document has no readable body.");
  const pieces: string[] = [];
  let characters = 0;
  const add = (text: string) => {
    characters += text.length;
    if (characters > MAX_CHARACTERS)
      throw new Error(
        "The document has more than 50,000 characters. Import a shorter brief or paste an excerpt.",
      );
    pieces.push(text);
  };
  const walk = (node: Element, depth: number): void => {
    if (depth > 100)
      throw new Error(
        "The Word document is nested too deeply to preview safely.",
      );
    if (
      ["w:del", "w:moveFrom", "w:drawing", "w:pict", "w:instrText"].includes(
        node.name ?? "",
      )
    )
      return;
    if (node.name === "w:t") {
      for (const child of node.elements ?? []) {
        if (typeof child.text === "string") add(child.text);
        else if (typeof child.cdata === "string") add(child.cdata);
      }
      return;
    }
    if (node.name === "w:tab") add("\t");
    if (node.name === "w:br" || node.name === "w:cr") add("\n");
    for (const child of node.elements ?? []) walk(child, depth + 1);
    if (node.name === "w:p" || node.name === "w:tr") add("\n");
    if (node.name === "w:tc") add("\t");
  };
  walk(body, 0);
  return pieces.join("").trim();
}

export async function readSourceDocument(
  chosen: string,
): Promise<SourceDocument> {
  if (!isAbsolute(chosen))
    throw new Error("Choose a file through the file picker.");
  const extension = extname(chosen).toLowerCase();
  if (![".txt", ".md", ".docx", ".csv"].includes(extension))
    throw new Error(
      "Choose a Word (.docx), Markdown (.md), text (.txt) or UTF-8 CSV (.csv) file.",
    );
  const format = extension.slice(1) as CaseSourcePreview["format"];
  const limit = format === "docx" ? MAX_DOCX_BYTES : MAX_TEXT_BYTES;
  const handle = await open(
    chosen,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => {
    throw new Error(
      "This file could not be opened. Choose a readable regular file, rather than a shortcut.",
    );
  });
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > limit)
      throw new Error(
        `Choose a nonempty file up to ${format === "docx" ? "4 MB" : "256 KB"}.`,
      );
    const buffer = Buffer.alloc(Math.min(before.size + 1, limit + 1));
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error(
        "The file changed while it was being read. Choose it again to review one stable version.",
      );
    bytes = buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
  const text = format === "docx"
    ? await wordText(bytes)
    : format === "csv" ? textFrom(bytes) : textFrom(bytes).trim();
  if (!text || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text))
    throw new Error(
      "This file has no usable text or contains unsupported control characters.",
    );
  if (text.length > MAX_CHARACTERS)
    throw new Error(
      "The document has more than 50,000 characters. Import a shorter brief or paste an excerpt.",
    );
  const table = format === "csv" ? parseDataTable(text) : null;
  return {
    fileName: basename(chosen)
      .replace(/[\u0000-\u001F\u007F]/gu, " ")
      .slice(0, 240),
    format,
    text,
    bytes: bytes.length,
    fileSha256: createHash("sha256").update(bytes).digest("hex"),
    textSha256: createHash("sha256").update(text).digest("hex"),
    coverage:
      table
        ? `Complete CSV snapshot: ${table.rows.length} data rows and ${table.columns.length} columns. Row numbers count records after the header, including quoted multiline cells as one record. Formulas remain text. The file is not watched.`
        : format === "docx"
        ? "Document body text only. Images, drawings, headers, footers, comments and tracked deletions are excluded. Review the preview against your original."
        : "UTF-8 text, with outer whitespace removed. Links and markup remain text.",
  };
}
