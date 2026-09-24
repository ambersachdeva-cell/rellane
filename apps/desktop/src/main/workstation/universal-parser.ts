/** Universal document ingest engine supporting Markdown, CSV, TSV, JSON, JSONL, HTML, DOCX, and PDF. */
import { Buffer } from "node:buffer";
import * as zlib from "node:zlib";

export type DocumentFormat = "markdown" | "csv" | "tsv" | "json" | "jsonl" | "html" | "docx" | "pdf" | "text";

export interface ParsedHeading {
  readonly level: number;
  readonly text: string;
}

export interface ParsedDocument {
  readonly format: DocumentFormat;
  readonly title: string;
  readonly markdown: string;
  readonly wordCount: number;
  readonly tableCount: number;
  readonly headings: readonly ParsedHeading[];
  readonly metadata: Record<string, string | number | boolean>;
}

export interface DocumentParseOptions {
  readonly filename?: string;
  readonly mimeType?: string;
  readonly maxChars?: number;
}

interface InternalParseResult {
  readonly markdown: string;
  readonly title?: string;
  readonly headings: readonly ParsedHeading[];
  readonly tableCount: number;
  readonly metadata: Record<string, string | number | boolean>;
}

const DEFAULT_MAX_CHARS = 500_000;

// Fast lookup table for filename extensions avoids regex overhead on repeated calls
const EXTENSION_FORMAT_MAP: Readonly<Record<string, DocumentFormat>> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdown": "markdown",
  ".mkd": "markdown",
  ".mdx": "markdown",
  ".csv": "csv",
  ".tsv": "tsv",
  ".tab": "tsv",
  ".json": "json",
  ".jsonl": "jsonl",
  ".ndjson": "jsonl",
  ".html": "html",
  ".htm": "html",
  ".xhtml": "html",
  ".docx": "docx",
  ".pdf": "pdf",
  ".txt": "text",
  ".text": "text",
  ".log": "text"
};

const MIME_FORMAT_MAP: Readonly<Record<string, DocumentFormat>> = {
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/tsv": "tsv",
  "application/json": "json",
  "application/x-ndjson": "jsonl",
  "application/x-jsonlines": "jsonl",
  "application/jsonl": "jsonl",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/docx": "docx",
  "application/pdf": "pdf",
  "text/plain": "text"
};

/** Detects the document format using magic signatures, explicit MIME declarations, and file extensions. */
export function detectFormat(filename?: string, mimeType?: string, contentPreview?: string): DocumentFormat {
  if (contentPreview !== undefined && contentPreview.length > 0) {
    const cleanPreview = contentPreview.replace(/^\uFEFF/u, "").trimStart();

    // Definite magic header takes precedence over potentially inaccurate file extensions
    if (cleanPreview.startsWith("%PDF-")) {
      return "pdf";
    }

    if (cleanPreview.startsWith("PK\x03\x04")) {
      if (cleanPreview.includes("word/") || cleanPreview.includes("[Content_Types].xml")) {
        return "docx";
      }
    }

    if (cleanPreview.startsWith("<?xml") && (cleanPreview.includes("<w:document") || cleanPreview.includes("<w:p"))) {
      return "docx";
    }

    if (
      cleanPreview.startsWith("<!DOCTYPE html") ||
      cleanPreview.startsWith("<!doctype html") ||
      cleanPreview.startsWith("<html") ||
      cleanPreview.startsWith("<HTML")
    ) {
      return "html";
    }
  }

  if (mimeType !== undefined && mimeType.length > 0) {
    const normalisedMime = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
    const formatFromMime = MIME_FORMAT_MAP[normalisedMime];
    if (formatFromMime !== undefined && normalisedMime !== "text/plain") {
      return formatFromMime;
    }
  }

  if (filename !== undefined && filename.length > 0) {
    const lastDot = filename.lastIndexOf(".");
    if (lastDot >= 0) {
      const ext = filename.slice(lastDot).toLowerCase();
      const formatFromExt = EXTENSION_FORMAT_MAP[ext];
      if (formatFromExt !== undefined) {
        return formatFromExt;
      }
    }
  }

  if (mimeType !== undefined && mimeType.length > 0) {
    const normalisedMime = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
    if (normalisedMime === "text/plain") {
      return "text";
    }
  }

  if (contentPreview !== undefined && contentPreview.length > 0) {
    const cleanPreview = contentPreview.replace(/^\uFEFF/u, "").trim();

    if (cleanPreview.startsWith("[") && cleanPreview.endsWith("]")) {
      try {
        JSON.parse(cleanPreview);
        return "json";
      } catch {
        // Preview may be partial or malformed, continue sniffing
      }
    }

    if (cleanPreview.startsWith("{") && cleanPreview.endsWith("}")) {
      try {
        JSON.parse(cleanPreview);
        return "json";
      } catch {
        // Preview may be partial or malformed, continue sniffing
      }
    }

    const previewLines = cleanPreview.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    if (previewLines.length > 1) {
      let allJsonLines = true;
      for (let i = 0; i < Math.min(previewLines.length, 5); i++) {
        const line = previewLines[i];
        if (line === undefined || !line.trim().startsWith("{")) {
          allJsonLines = false;
          break;
        }
        try {
          JSON.parse(line);
        } catch {
          allJsonLines = false;
          break;
        }
      }
      if (allJsonLines) {
        return "jsonl";
      }
    }

    if (cleanPreview.includes("<p>") || cleanPreview.includes("</div>") || cleanPreview.includes("</h1>")) {
      return "html";
    }

    if (cleanPreview.startsWith("# ") || cleanPreview.startsWith("## ") || cleanPreview.startsWith("---\n")) {
      return "markdown";
    }
  }

  return "text";
}

/** Counts words across rendered Markdown text, respecting empty document boundaries. */
function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  const words = trimmed.split(/\s+/u);
  return words.length;
}

/** Extracts Markdown headings (# Title through ###### Subheading) with their structural levels. */
function extractHeadingsFromMarkdown(markdown: string): readonly ParsedHeading[] {
  const headings: ParsedHeading[] = [];
  const lines = markdown.split(/\r?\n/u);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    const match = line.match(/^(#{1,6})\s+(.+)$/u);
    if (match !== null) {
      const hashes = match[1];
      const text = match[2];
      if (hashes !== undefined && text !== undefined) {
        headings.push({
          level: hashes.length,
          text: text.trim()
        });
      }
    }
  }

  return headings;
}

/** Counts distinct Markdown table blocks in text by locating header-separator pairs. */
function countMarkdownTables(markdown: string): number {
  const lines = markdown.split(/\r?\n/u);
  let count = 0;
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    const trimmed = line.trim();
    const isTableRow = trimmed.startsWith("|") && trimmed.endsWith("|");
    const isSeparator = isTableRow && /^\|(?::?-+:?\|)+$/u.test(trimmed);

    if (isSeparator && !inTable) {
      inTable = true;
      count++;
    } else if (!isTableRow) {
      inTable = false;
    }
  }

  return count;
}

/** Determines the canonical document title from explicit metadata, top headings, or clean filename. */
function resolveTitle(
  explicitTitle: string | undefined,
  headings: readonly ParsedHeading[],
  filename: string | undefined
): string {
  if (explicitTitle !== undefined && explicitTitle.trim().length > 0) {
    return explicitTitle.trim();
  }

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    if (heading !== undefined && heading.level === 1) {
      return heading.text;
    }
  }

  if (headings.length > 0) {
    const firstHeading = headings[0];
    if (firstHeading !== undefined) {
      return firstHeading.text;
    }
  }

  if (filename !== undefined && filename.trim().length > 0) {
    const segments = filename.split(/[\/\\]/u);
    const base = segments[segments.length - 1] ?? filename;
    const withoutExt = base.replace(/\.[^/.]+$/u, "");
    return withoutExt.length > 0 ? withoutExt : base;
  }

  return "Untitled Document";
}

/** Parses RFC-4180 delimited records handling embedded quotes, commas, and multi-line fields. */
function parseDelimited(text: string, delimiter: string): readonly (readonly string[])[] {
  const rows: (readonly string[])[] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    if (char === undefined) {
      break;
    }

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          // Consecutive double-quotes represent an escaped literal quotation mark
          currentField += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        currentField += char;
        i++;
      }
    } else if (char === '"') {
      inQuotes = true;
      i++;
    } else if (char === delimiter) {
      currentRow.push(currentField);
      currentField = "";
      i++;
    } else if (char === "\r") {
      if (i + 1 < text.length && text[i + 1] === "\n") {
        i++;
      }
      currentRow.push(currentField);
      currentField = "";
      rows.push(currentRow);
      currentRow = [];
      i++;
    } else if (char === "\n") {
      currentRow.push(currentField);
      currentField = "";
      rows.push(currentRow);
      currentRow = [];
      i++;
    } else {
      currentField += char;
      i++;
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  if (rows.length > 1) {
    const lastRow = rows[rows.length - 1];
    if (lastRow !== undefined && lastRow.length === 1 && lastRow[0] === "") {
      rows.pop();
    }
  }

  return rows;
}

/** Formats delimited record rows into a clean Markdown table with escaped cell contents. */
function delimitedToMarkdown(rows: readonly (readonly string[])[]): {
  readonly markdown: string;
  readonly tableCount: number;
  readonly rowCount: number;
  readonly columnCount: number;
} {
  if (rows.length === 0) {
    return { markdown: "", tableCount: 0, rowCount: 0, columnCount: 0 };
  }

  let maxCols = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row !== undefined && row.length > maxCols) {
      maxCols = row.length;
    }
  }

  if (maxCols === 0) {
    return { markdown: "", tableCount: 0, rowCount: 0, columnCount: 0 };
  }

  const formatCell = (val: string | undefined): string => {
    if (val === undefined) {
      return "";
    }
    // Pipe characters and newlines are sanitized so they do not break table row alignment
    return val.replace(/\|/gu, "\\|").replace(/\r?\n/gu, "<br>").trim();
  };

  const lines: string[] = [];
  const headerRow = rows[0];
  const headerCells: string[] = [];
  for (let c = 0; c < maxCols; c++) {
    const cellVal = headerRow !== undefined && c < headerRow.length ? headerRow[c] : "";
    headerCells.push(formatCell(cellVal));
  }
  lines.push(`| ${headerCells.join(" | ")} |`);

  const separatorCells: string[] = [];
  for (let c = 0; c < maxCols; c++) {
    separatorCells.push("---");
  }
  lines.push(`| ${separatorCells.join(" | ")} |`);

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rowCells: string[] = [];
    for (let c = 0; c < maxCols; c++) {
      const cellVal = row !== undefined && c < row.length ? row[c] : "";
      rowCells.push(formatCell(cellVal));
    }
    lines.push(`| ${rowCells.join(" | ")} |`);
  }

  return {
    markdown: lines.join("\n"),
    tableCount: 1,
    rowCount: rows.length,
    columnCount: maxCols
  };
}

/** Decodes standard, hexadecimal, and decimal HTML entities back into plain characters. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&nbsp;/gu, " ")
    .replace(/&mdash;/gu, "—")
    .replace(/&ndash;/gu, "–")
    .replace(/&#x([0-9a-fA-F]+);/gu, (_match, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isNaN(code) ? _match : String.fromCharCode(code);
    })
    .replace(/&#(\d+);/gu, (_match, dec: string) => {
      const code = parseInt(dec, 10);
      return Number.isNaN(code) ? _match : String.fromCharCode(code);
    })
    .replace(/&amp;/gu, "&");
}

/** Converts structured HTML documents into clean Markdown, extracting tables, headers, and metadata. */
function parseHtmlContent(html: string): InternalParseResult {
  let clean = html
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/giu, "");

  let extractedTitle: string | undefined;
  const titleMatch = clean.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu);
  if (titleMatch !== null && titleMatch[1] !== undefined) {
    extractedTitle = decodeHtmlEntities(titleMatch[1].trim());
  }

  const metadata: Record<string, string | number | boolean> = {};
  const metaMatches = clean.matchAll(/<meta\b[^>]*>/giu);
  for (const match of metaMatches) {
    const tag = match[0];
    const nameMatch = tag.match(/(?:name|property)=["']([^"']*)["']/iu);
    const contentMatch = tag.match(/content=["']([^"']*)["']/iu);
    if (nameMatch !== null && contentMatch !== null) {
      const key = nameMatch[1];
      const val = contentMatch[1];
      if (key !== undefined && val !== undefined) {
        metadata[key] = decodeHtmlEntities(val);
      }
    }
  }

  let tableCount = 0;
  clean = clean.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/giu, (_match, tableBody: string) => {
    tableCount++;
    const rows: string[][] = [];
    const rowMatches = tableBody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu);

    for (const rMatch of rowMatches) {
      const rowContent = rMatch[1];
      if (rowContent === undefined) {
        continue;
      }
      const cells: string[] = [];
      const cellMatches = rowContent.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/giu);
      for (const cMatch of cellMatches) {
        const cellHtml = cMatch[1];
        if (cellHtml === undefined) {
          continue;
        }
        const cellText = decodeHtmlEntities(cellHtml.replace(/<[^>]+>/gu, "")).trim();
        cells.push(cellText.replace(/\|/gu, "\\|"));
      }
      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    if (rows.length === 0) {
      return "";
    }

    let maxCols = 0;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (row !== undefined && row.length > maxCols) {
        maxCols = row.length;
      }
    }

    const lines: string[] = [];
    const headerRow = rows[0];
    const headerCells: string[] = [];
    for (let c = 0; c < maxCols; c++) {
      const val = headerRow !== undefined && c < headerRow.length ? headerRow[c] : "";
      headerCells.push(val ?? "");
    }
    lines.push(`| ${headerCells.join(" | ")} |`);

    const sepCells: string[] = [];
    for (let c = 0; c < maxCols; c++) {
      sepCells.push("---");
    }
    lines.push(`| ${sepCells.join(" | ")} |`);

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const rowCells: string[] = [];
      for (let c = 0; c < maxCols; c++) {
        const val = row !== undefined && c < row.length ? row[c] : "";
        rowCells.push(val ?? "");
      }
      lines.push(`| ${rowCells.join(" | ")} |`);
    }

    return `\n\n${lines.join("\n")}\n\n`;
  });

  for (let level = 1; level <= 6; level++) {
    const hashes = "#".repeat(level);
    const hRegex = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, "giu");
    clean = clean.replace(hRegex, (_m, content: string) => {
      const text = decodeHtmlEntities(content.replace(/<[^>]+>/gu, "")).trim();
      return `\n\n${hashes} ${text}\n\n`;
    });
  }

  clean = clean.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/giu, (_m, content: string) => {
    const text = decodeHtmlEntities(content.replace(/<[^>]+>/gu, "")).trim();
    return `\n- ${text}`;
  });
  clean = clean.replace(/<\/?(?:ul|ol)\b[^>]*>/giu, "\n");

  clean = clean.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/giu, (_m, href: string, text: string) => {
    const linkText = decodeHtmlEntities(text.replace(/<[^>]+>/gu, "")).trim();
    const label = linkText.length > 0 ? linkText : href;
    return `[${label}](${href})`;
  });

  clean = clean
    .replace(/<(?:b|strong)\b[^>]*>([\s\S]*?)<\/(?:b|strong)>/giu, "**$1**")
    .replace(/<(?:i|em)\b[^>]*>([\s\S]*?)<\/(?:i|em)>/giu, "*$1*")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/giu, "`$1`")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/giu, "\n```\n$1\n```\n")
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/giu, "\n> $1\n")
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/giu, "\n\n$1\n\n")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<hr\s*\/?>/giu, "\n---\n")
    .replace(/<[^>]+>/gu, "");

  clean = decodeHtmlEntities(clean);
  clean = clean.replace(/\n{3,}/gu, "\n\n").trim();

  const headings = extractHeadingsFromMarkdown(clean);

  if (extractedTitle !== undefined) {
    return { markdown: clean, title: extractedTitle, headings, tableCount, metadata };
  }
  return { markdown: clean, headings, tableCount, metadata };
}

/** Extracts files from a ZIP archive by walking local file headers without native dependencies. */
function unpackZipArchive(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  while (pos + 30 <= bytes.length) {
    const signature = view.getUint32(pos, true);
    if (signature !== 0x04034b50) {
      break;
    }

    const compressionMethod = view.getUint16(pos + 8, true);
    const compressedSize = view.getUint32(pos + 18, true);
    const fileNameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);

    const nameStart = pos + 30;
    if (nameStart + fileNameLen > bytes.length) {
      break;
    }

    const fileName = new TextDecoder("utf-8").decode(bytes.subarray(nameStart, nameStart + fileNameLen));
    const dataStart = nameStart + fileNameLen + extraLen;
    if (dataStart + compressedSize > bytes.length) {
      break;
    }

    const compressedSlice = bytes.subarray(dataStart, dataStart + compressedSize);
    try {
      if (compressionMethod === 0) {
        entries.set(fileName, compressedSlice);
      } else if (compressionMethod === 8) {
        // Raw inflate handles standard Deflate streams without zlib headers
        const decompressed = zlib.inflateRawSync(Buffer.from(compressedSlice));
        entries.set(fileName, new Uint8Array(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength));
      }
    } catch {
      // Corrupted entry is skipped to preserve readable sibling streams
    }

    pos = dataStart + compressedSize;
  }

  return entries;
}

/** Parses DOCX WordprocessingML XML, translating paragraphs, styles, and table nodes to Markdown. */
function parseDocxXml(xmlText: string): InternalParseResult {
  let tableCount = 0;
  let workingXml = xmlText;

  workingXml = workingXml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/giu, (tableXml) => {
    tableCount++;
    const rows: string[][] = [];
    const trMatches = tableXml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/giu);

    for (const trMatch of trMatches) {
      const trXml = trMatch[0];
      const cells: string[] = [];
      const tcMatches = trXml.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/giu);

      for (const tcMatch of tcMatches) {
        const tcXml = tcMatch[0];
        const textParts: string[] = [];
        const tMatches = tcXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/giu);
        for (const tMatch of tMatches) {
          const textVal = tMatch[1];
          if (textVal !== undefined) {
            textParts.push(textVal);
          }
        }
        const cellContent = decodeHtmlEntities(textParts.join("")).trim();
        cells.push(cellContent.replace(/\|/gu, "\\|"));
      }

      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    if (rows.length === 0) {
      return "";
    }

    let maxCols = 0;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (row !== undefined && row.length > maxCols) {
        maxCols = row.length;
      }
    }

    const lines: string[] = [];
    const headerRow = rows[0];
    const headerCells: string[] = [];
    for (let c = 0; c < maxCols; c++) {
      const val = headerRow !== undefined && c < headerRow.length ? headerRow[c] : "";
      headerCells.push(val ?? "");
    }
    lines.push(`| ${headerCells.join(" | ")} |`);

    const sepCells: string[] = [];
    for (let c = 0; c < maxCols; c++) {
      sepCells.push("---");
    }
    lines.push(`| ${sepCells.join(" | ")} |`);

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const rowCells: string[] = [];
      for (let c = 0; c < maxCols; c++) {
        const val = row !== undefined && c < row.length ? row[c] : "";
        rowCells.push(val ?? "");
      }
      lines.push(`| ${rowCells.join(" | ")} |`);
    }

    return `<w:p><w:r><w:t>${lines.join("\n")}</w:t></w:r></w:p>`;
  });

  const paragraphs: string[] = [];
  const pMatches = workingXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/giu);

  for (const pMatch of pMatches) {
    const pXml = pMatch[0];

    let headingLevel: number | undefined;
    const styleMatch = pXml.match(/<w:pStyle\s+[^>]*w:val=["']([^"']*)["']/iu);
    if (styleMatch !== null && styleMatch[1] !== undefined) {
      const styleVal = styleMatch[1].toLowerCase();
      const headingNumMatch = styleVal.match(/heading\s*(\d)/iu);
      if (headingNumMatch !== null && headingNumMatch[1] !== undefined) {
        headingLevel = Math.min(Math.max(parseInt(headingNumMatch[1], 10), 1), 6);
      } else if (styleVal === "title") {
        headingLevel = 1;
      } else if (styleVal === "subtitle") {
        headingLevel = 2;
      }
    }

    const isListItem = pXml.includes("<w:numPr") || (styleMatch !== null && styleMatch[1]?.toLowerCase().includes("list"));

    const textRuns: string[] = [];
    const rMatches = pXml.matchAll(/<w:r\b[\s\S]*?<\/w:r>/giu);
    for (const rMatch of rMatches) {
      const rXml = rMatch[0];
      const isBold = rXml.includes("<w:b/>") || rXml.includes('<w:b w:val="true"') || rXml.includes('<w:b w:val="1"');
      const isItalic = rXml.includes("<w:i/>") || rXml.includes('<w:i w:val="true"') || rXml.includes('<w:i w:val="1"');

      const tMatches = rXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/giu);
      for (const tMatch of tMatches) {
        let tContent = tMatch[1];
        if (tContent !== undefined && tContent.length > 0) {
          tContent = decodeHtmlEntities(tContent);
          if (isBold && isItalic) {
            tContent = `***${tContent}***`;
          } else if (isBold) {
            tContent = `**${tContent}**`;
          } else if (isItalic) {
            tContent = `*${tContent}*`;
          }
          textRuns.push(tContent);
        }
      }

      if (rXml.includes("<w:tab/>")) {
        textRuns.push("\t");
      }
      if (rXml.includes("<w:br/>")) {
        textRuns.push("\n");
      }
    }

    const paragraphText = textRuns.join("").trim();
    if (paragraphText.length > 0) {
      if (headingLevel !== undefined) {
        paragraphs.push(`${'#'.repeat(headingLevel)} ${paragraphText}`);
      } else if (isListItem) {
        paragraphs.push(`- ${paragraphText}`);
      } else {
        paragraphs.push(paragraphText);
      }
    }
  }

  const markdown = paragraphs.join("\n\n").trim();
  const headings = extractHeadingsFromMarkdown(markdown);
  const metadata: Record<string, string | number | boolean> = {};

  return { markdown, headings, tableCount, metadata };
}

/** Parses literal string escapes in PDF syntax (parentheses matching and octal codes). */
function parsePdfLiteralString(raw: string): string {
  let result = "";
  let i = 0;
  while (i < raw.length) {
    const char = raw[i];
    if (char === undefined) {
      break;
    }
    if (char === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === "n") {
        result += "\n";
        i += 2;
      } else if (next === "r") {
        result += "\r";
        i += 2;
      } else if (next === "t") {
        result += "\t";
        i += 2;
      } else if (next === "b") {
        result += "\b";
        i += 2;
      } else if (next === "f") {
        result += "\f";
        i += 2;
      } else if (next === "(" || next === ")" || next === "\\") {
        result += next;
        i += 2;
      } else if (next !== undefined && /[0-7]/u.test(next)) {
        let octal = next;
        let count = 1;
        while (count < 3 && i + 1 + count < raw.length) {
          const digit = raw[i + 1 + count];
          if (digit !== undefined && /[0-7]/u.test(digit)) {
            octal += digit;
            count++;
          } else {
            break;
          }
        }
        result += String.fromCharCode(parseInt(octal, 8));
        i += 1 + count;
      } else {
        result += next ?? "";
        i += 2;
      }
    } else {
      result += char;
      i++;
    }
  }
  return result;
}

/** Decodes hexadecimal strings formatted within PDF angle brackets. */
function parsePdfHexString(hex: string): string {
  const clean = hex.replace(/[^0-9A-Fa-f]/gu, "");
  let result = "";
  for (let i = 0; i < clean.length; i += 2) {
    const byteHex = clean.length === i + 1 ? `${clean[i] ?? ""}0` : clean.slice(i, i + 2);
    result += String.fromCharCode(parseInt(byteHex, 16));
  }
  return result;
}

/** Parses PDF content streams, unpacking /BT ... /ET text objects and Tj/TJ operations. */
function parsePdfContent(content: string | Uint8Array): InternalParseResult {
  const rawBytes = typeof content === "string" ? Buffer.from(content, "latin1") : Buffer.from(content);
  const rawText = typeof content === "string" ? content : new TextDecoder("latin1").decode(content);

  let extractedTitle: string | undefined;
  const titleMatch = rawText.match(/\/Title\s*\(([^)]*)\)/u);
  if (titleMatch !== null && titleMatch[1] !== undefined) {
    extractedTitle = parsePdfLiteralString(titleMatch[1]);
  }

  const streamTexts: string[] = [];
  const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/gu;
  let match: RegExpExecArray | null = null;

  while ((match = streamRegex.exec(rawText)) !== null) {
    const matchIndex = match.index;
    const streamContent = match[1];
    if (streamContent === undefined) {
      continue;
    }

    const preDict = rawText.slice(Math.max(0, matchIndex - 500), matchIndex);
    const isFlate = preDict.includes("/FlateDecode");

    if (isFlate) {
      // Locate binary stream boundaries in rawBytes to avoid encoding corruption during decompression
      const streamMarker = Buffer.from("stream");
      const markerIndex = rawBytes.indexOf(streamMarker, Math.max(0, matchIndex - 10));
      if (markerIndex !== -1) {
        let dataStart = markerIndex + 6;
        if (rawBytes[dataStart] === 0x0d) {
          dataStart++;
        }
        if (rawBytes[dataStart] === 0x0a) {
          dataStart++;
        }

        const endMarker = Buffer.from("endstream");
        const endIndex = rawBytes.indexOf(endMarker, dataStart);
        if (endIndex !== -1) {
          const compressedSlice = rawBytes.subarray(dataStart, endIndex);
          try {
            const decompressed = zlib.inflateSync(compressedSlice);
            streamTexts.push(new TextDecoder("latin1").decode(decompressed));
            continue;
          } catch {
            try {
              const rawDecomp = zlib.inflateRawSync(compressedSlice);
              streamTexts.push(new TextDecoder("latin1").decode(rawDecomp));
              continue;
            } catch {
              // Fall through to uncompressed string interpretation
            }
          }
        }
      }
    }

    streamTexts.push(streamContent);
  }

  if (streamTexts.length === 0) {
    streamTexts.push(rawText);
  }

  const paragraphs: string[] = [];

  for (let s = 0; s < streamTexts.length; s++) {
    const stream = streamTexts[s];
    if (stream === undefined) {
      continue;
    }

    const btMatches = stream.matchAll(/\bBT\b([\s\S]*?)\bET\b/gu);
    for (const btMatch of btMatches) {
      const btBody = btMatch[1];
      if (btBody === undefined) {
        continue;
      }

      const blockParts: string[] = [];
      const tjOpRegex = /(?:\((?:[^\\()]+|\\.)*\)|<[0-9a-fA-F\s]+>)\s*Tj|\[([\s\S]*?)\]\s*TJ|T\*|(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+T[dD]/gu;
      let opMatch: RegExpExecArray | null = null;

      while ((opMatch = tjOpRegex.exec(btBody)) !== null) {
        const fullOp = opMatch[0];
        if (fullOp.endsWith("Tj")) {
          const literalMatch = fullOp.match(/^\(((?:[^\\()]+|\\.)*)\)\s*Tj$/u);
          if (literalMatch !== null && literalMatch[1] !== undefined) {
            blockParts.push(parsePdfLiteralString(literalMatch[1]));
          } else {
            const hexMatch = fullOp.match(/^<([0-9a-fA-F\s]+)>\s*Tj$/u);
            if (hexMatch !== null && hexMatch[1] !== undefined) {
              blockParts.push(parsePdfHexString(hexMatch[1]));
            }
          }
        } else if (fullOp.endsWith("TJ")) {
          const arrayContent = opMatch[1];
          if (arrayContent !== undefined) {
            const tjParts: string[] = [];
            const itemRegex = /\(((?:[^\\()]+|\\.)*)\)|<([0-9a-fA-F\s]+)>|(-?\d+(?:\.\d+)?)/gu;
            let itemMatch: RegExpExecArray | null = null;

            while ((itemMatch = itemRegex.exec(arrayContent)) !== null) {
              if (itemMatch[1] !== undefined) {
                tjParts.push(parsePdfLiteralString(itemMatch[1]));
              } else if (itemMatch[2] !== undefined) {
                tjParts.push(parsePdfHexString(itemMatch[2]));
              } else if (itemMatch[3] !== undefined) {
                const spacing = parseFloat(itemMatch[3]);
                // Kerning offsets below -100 PDF glyph units represent whitespace between words
                if (spacing <= -100) {
                  const last = tjParts[tjParts.length - 1];
                  if (last !== undefined && !last.endsWith(" ")) {
                    tjParts.push(" ");
                  }
                }
              }
            }
            blockParts.push(tjParts.join(""));
          }
        } else if (fullOp === "T*" || fullOp.endsWith("Td") || fullOp.endsWith("TD")) {
          blockParts.push("\n");
        }
      }

      const blockText = blockParts.join("").trim();
      if (blockText.length > 0) {
        paragraphs.push(blockText);
      }
    }
  }

  const markdown = paragraphs.join("\n\n").trim();
  const headings = extractHeadingsFromMarkdown(markdown);
  const tableCount = countMarkdownTables(markdown);
  const metadata: Record<string, string | number | boolean> = {};

  if (extractedTitle !== undefined) {
    return { markdown, title: extractedTitle, headings, tableCount, metadata };
  }
  return { markdown, headings, tableCount, metadata };
}

/** Formats an array of uniform JSON objects into a structured Markdown table. */
function jsonArrayToMarkdown(items: readonly unknown[]): {
  readonly markdown: string;
  readonly tableCount: number;
  readonly recordCount: number;
  readonly columnCount: number;
} | null {
  if (items.length === 0) {
    return { markdown: "", tableCount: 0, recordCount: 0, columnCount: 0 };
  }

  const isObject = (item: unknown): item is Record<string, unknown> => {
    return typeof item === "object" && item !== null && !Array.isArray(item);
  };

  const hasObjects = items.some(isObject);
  if (!hasObjects) {
    return null;
  }

  const keys: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (isObject(item)) {
      const itemKeys = Object.keys(item);
      for (let k = 0; k < itemKeys.length; k++) {
        const key = itemKeys[k];
        if (key !== undefined && !keys.includes(key)) {
          keys.push(key);
        }
      }
    }
  }

  if (keys.length === 0) {
    return { markdown: "", tableCount: 0, recordCount: items.length, columnCount: 0 };
  }

  const formatCell = (val: unknown): string => {
    if (val === undefined || val === null) {
      return "";
    }
    const str = typeof val === "object" ? JSON.stringify(val) : String(val);
    return str.replace(/\|/gu, "\\|").replace(/\\r?\\n/gu, "<br>").trim();
  };

  const lines: string[] = [];
  lines.push(`| ${keys.map((k) => formatCell(k)).join(" | ")} |`);
  lines.push(`| ${keys.map(() => "---").join(" | ")} |`);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const rowCells: string[] = [];
    if (isObject(item)) {
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        rowCells.push(key !== undefined ? formatCell(item[key]) : "");
      }
    } else {
      rowCells.push(formatCell(item));
      for (let k = 1; k < keys.length; k++) {
        rowCells.push("");
      }
    }
    lines.push(`| ${rowCells.join(" | ")} |`);
  }

  return {
    markdown: lines.join("\n"),
    tableCount: 1,
    recordCount: items.length,
    columnCount: keys.length
  };
}

/** Ingests and transforms diverse document formats into clean Markdown and structured metadata. */
export function parseDocument(content: string | Uint8Array, options?: DocumentParseOptions): ParsedDocument {
  const filename = options?.filename;
  const mimeType = options?.mimeType;
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;

  const preview = typeof content === "string"
    ? content.slice(0, 4096)
    : new TextDecoder("utf-8", { fatal: false }).decode(content.slice(0, 4096));

  const format = detectFormat(filename, mimeType, preview);
  let parsed: InternalParseResult;

  switch (format) {
    case "markdown": {
      const text = typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: false }).decode(content);
      const metadata: Record<string, string | number | boolean> = {};
      let body = text;
      let docTitle: string | undefined;

      const frontmatterMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/u);
      if (frontmatterMatch !== null && frontmatterMatch[1] !== undefined) {
        const rawYaml = frontmatterMatch[1];
        const matchedLength = frontmatterMatch[0]?.length ?? 0;
        body = text.slice(matchedLength);
        const lines = rawYaml.split(/\r?\n/u);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line === undefined) {
            continue;
          }
          const colonIdx = line.indexOf(":");
          if (colonIdx > 0) {
            const key = line.slice(0, colonIdx).trim();
            let val = line.slice(colonIdx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (val === "true") {
              metadata[key] = true;
            } else if (val === "false") {
              metadata[key] = false;
            } else if (/^-?\d+(?:\.\d+)?$/u.test(val)) {
              metadata[key] = Number(val);
            } else {
              metadata[key] = val;
            }
            if (key.toLowerCase() === "title" && typeof metadata[key] === "string") {
              docTitle = metadata[key] as string;
            }
          }
        }
      }

      const cleanMarkdown = body.trim();
      const headings = extractHeadingsFromMarkdown(cleanMarkdown);
      const tableCount = countMarkdownTables(cleanMarkdown);

      if (docTitle !== undefined) {
        parsed = { markdown: cleanMarkdown, title: docTitle, headings, tableCount, metadata };
      } else {
        parsed = { markdown: cleanMarkdown, headings, tableCount, metadata };
      }
      break;
    }

    case "csv": {
      const text = typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: false }).decode(content);
      const rows = parseDelimited(text, ",");
      const table = delimitedToMarkdown(rows);
      const metadata: Record<string, string | number | boolean> = {
        rowCount: table.rowCount,
        columnCount: table.columnCount
      };
      parsed = {
        markdown: table.markdown,
        headings: [],
        tableCount: table.tableCount,
        metadata
      };
      break;
    }

    case "tsv": {
      const text = typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: false }).decode(content);
      const rows = parseDelimited(text, "\t");
      const table = delimitedToMarkdown(rows);
      const metadata: Record<string, string | number | boolean> = {
        rowCount: table.rowCount,
        columnCount: table.columnCount
      };
      parsed = {
        markdown: table.markdown,
        headings: [],
        tableCount: table.tableCount,
        metadata
      };
      break;
    }

    case "json": {
      const text = typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: false }).decode(content);
      try {
        const parsedJson = JSON.parse(text);
        if (Array.isArray(parsedJson)) {
          const table = jsonArrayToMarkdown(parsedJson);
          if (table !== null) {
            parsed = {
              markdown: table.markdown,
              headings: [],
              tableCount: table.tableCount,
              metadata: { recordCount: table.recordCount, columnCount: table.columnCount }
            };
          } else {
            const markdown = parsedJson.map((item) => `- ${String(item)}`).join("\n");
            parsed = {
              markdown,
              headings: [],
              tableCount: 0,
              metadata: { recordCount: parsedJson.length }
            };
          }
        } else if (typeof parsedJson === "object" && parsedJson !== null) {
          const entries = Object.entries(parsedJson as Record<string, unknown>);
          const rows: (readonly string[])[] = [["Property", "Value"]];
          for (let e = 0; e < entries.length; e++) {
            const entry = entries[e];
            if (entry !== undefined) {
              const key = entry[0];
              const val = entry[1];
              rows.push([key, typeof val === "object" ? JSON.stringify(val) : String(val)]);
            }
          }
          const table = delimitedToMarkdown(rows);
          parsed = {
            markdown: table.markdown,
            headings: [],
            tableCount: 1,
            metadata: { propertyCount: entries.length }
          };
        } else {
          const markdown = String(parsedJson);
          parsed = { markdown, headings: [], tableCount: 0, metadata: {} };
        }
      } catch {
        parsed = { markdown: text.trim(), headings: [], tableCount: 0, metadata: { error: "Malformed JSON" } };
      }
      break;
    }

    case "jsonl": {
      const text = typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: false }).decode(content);
      const lines = text.split(/\r?\n/u).filter((l) => l.trim().length > 0);
      const records: unknown[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line !== undefined) {
          try {
            records.push(JSON.parse(line));
          } catch {
            // Discard unparseable line to maintain clean tabular shape
          }
        }
      }
      const table = jsonArrayToMarkdown(records);
      if (table !== null) {
        parsed = {
          markdown: table.markdown,
          headings: [],
          tableCount: table.tableCount,
          metadata: { recordCount: table.recordCount, columnCount: table.columnCount }
        };
      } else {
        const markdown = records.map((r) => `- ${JSON.stringify(r)}`).join("\n");
        parsed = { markdown, headings: [], tableCount: 0, metadata: { recordCount: records.length } };
      }
      break;
    }

    case "html": {
      const text = typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: false }).decode(content);
      parsed = parseHtmlContent(text);
      break;
    }

    case "docx": {
      const bytes = typeof content === "string" ? Buffer.from(content, "binary") : content;
      let xmlContent: string;

      if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
        const zipFiles = unpackZipArchive(bytes);
        const docXmlBytes = zipFiles.get("word/document.xml");
        if (docXmlBytes !== undefined) {
          xmlContent = new TextDecoder("utf-8").decode(docXmlBytes);
        } else {
          xmlContent = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        }
      } else {
        xmlContent = typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      }

      parsed = parseDocxXml(xmlContent);
      break;
    }

    case "pdf": {
      parsed = parsePdfContent(content);
      break;
    }

    case "text":
    default: {
      const text = typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: false }).decode(content);
      const cleanText = text.trim();
      const headings = extractHeadingsFromMarkdown(cleanText);
      const tableCount = countMarkdownTables(cleanText);
      parsed = { markdown: cleanText, headings, tableCount, metadata: {} };
      break;
    }
  }

  let finalMarkdown = parsed.markdown;
  let finalHeadings = parsed.headings;
  let finalTableCount = parsed.tableCount;
  const finalMetadata: Record<string, string | number | boolean> = { ...parsed.metadata };

  if (finalMarkdown.length > maxChars) {
    finalMarkdown = finalMarkdown.slice(0, maxChars);
    finalHeadings = extractHeadingsFromMarkdown(finalMarkdown);
    finalTableCount = countMarkdownTables(finalMarkdown);
    finalMetadata["truncated"] = true;
  }

  const wordCount = countWords(finalMarkdown);
  const title = resolveTitle(parsed.title, finalHeadings, filename);

  return {
    format,
    title,
    markdown: finalMarkdown,
    wordCount,
    tableCount: finalTableCount,
    headings: finalHeadings,
    metadata: finalMetadata
  };
}
