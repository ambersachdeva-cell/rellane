export type PasteKind = "text" | "markdown" | "csv" | "json" | "code" | "url" | "image";

export interface PasteAnalysis {
  readonly kind: PasteKind;
  readonly title: string;
  readonly preview: string;
  readonly chars: number;
  readonly lines: number;
  /** Set for `code`: the language it looks like, or null. */
  readonly language: string | null;
  /** Set for `url`: the host, so the owner sees where it points. */
  readonly host: string | null;
  readonly warnings: readonly string[];
}

export const MAX_PASTE_CHARS = 500_000;
export const PREVIEW_CHARS = 400;

const MAX_TITLE_CHARS = 60;
const MAX_UNUSUALLY_LONG_LINE = 800;

// Secrets and credentials that must be flagged before becoming a persistent source.
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY/i;
const PGP_PRIVATE_KEY_PATTERN = /-----BEGIN PGP PRIVATE KEY BLOCK/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9_\-.~+/]+=*/i;
const KNOWN_TOKEN_PATTERN = /\b(?:sk-[a-zA-Z0-9_-]{20,}|sk-proj-[a-zA-Z0-9_-]{20,}|sk-ant-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{30,}|gho_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{40,}|xox[baprs]-[0-9a-zA-Z]{10,}|AKIA[0-9A-Z]{16})\b/;
const JWT_PATTERN = /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_\-+/=]{10,}\b/;
const ASSIGNMENT_TOKEN_PATTERN = /\b(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|secret[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/i;

// Unicode directional overrides and zero-width characters used to disguise code or text.
const BIDI_OR_INVISIBLE_PATTERN = /[\u200B-\u200D\u200E\u200F\u061C\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

function findFirstMeaningfulLine(lines: readonly string[]): string | null {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function formatTitle(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "Pasted text";
  }
  if (trimmed.length > MAX_TITLE_CHARS) {
    return trimmed.slice(0, MAX_TITLE_CHARS).trimEnd();
  }
  return trimmed;
}

function collectWarnings(
  text: string,
  lines: readonly string[],
  kind: PasteKind
): readonly string[] {
  const warnings: string[] = [];

  if (text.length > MAX_PASTE_CHARS) {
    warnings.push("This paste exceeds the limit of 500,000 characters.");
  }

  const hasPrivateKey = PRIVATE_KEY_PATTERN.test(text) || PGP_PRIVATE_KEY_PATTERN.test(text);
  if (hasPrivateKey) {
    warnings.push("This paste appears to contain a private key.");
  }

  const hasToken =
    BEARER_PATTERN.test(text) ||
    KNOWN_TOKEN_PATTERN.test(text) ||
    JWT_PATTERN.test(text) ||
    ASSIGNMENT_TOKEN_PATTERN.test(text);
  if (hasToken) {
    warnings.push("This paste appears to contain an API token or authentication secret.");
  }

  // Base64 data URLs naturally exceed normal line lengths without being minified code.
  if (kind !== "image") {
    let hasLongLine = false;
    for (const line of lines) {
      if (line.length > MAX_UNUSUALLY_LONG_LINE) {
        hasLongLine = true;
        break;
      }
    }
    if (hasLongLine) {
      warnings.push("This paste contains an unusually long line, which may indicate minified content.");
    }
  }

  const hasCrlf = text.includes("\r\n");
  const hasLoneLf = /[^\r]\n|^\n/.test(text);
  const hasLoneCr = /\r[^\n]|\r$/.test(text);
  if ((hasCrlf && hasLoneLf) || (hasCrlf && hasLoneCr) || (hasLoneLf && hasLoneCr)) {
    warnings.push("This paste contains mixed line endings.");
  }

  if (BIDI_OR_INVISIBLE_PATTERN.test(text)) {
    warnings.push("This paste contains invisible or bidirectional control characters.");
  }

  return warnings;
}

interface ImageMatch {
  readonly title: string;
}

function tryMatchImage(trimmed: string): ImageMatch | null {
  if (trimmed.startsWith("data:image/")) {
    const mimeMatch = trimmed.match(/^data:image\/([a-zA-Z0-9+.-]+)/);
    let title = "Image";
    if (mimeMatch && mimeMatch[1]) {
      const sub = mimeMatch[1].toLowerCase();
      if (sub.includes("png")) {
        title = "PNG image";
      } else if (sub.includes("jpeg") || sub.includes("jpg")) {
        title = "JPEG image";
      } else if (sub.includes("svg")) {
        title = "SVG image";
      } else if (sub.includes("webp")) {
        title = "WebP image";
      } else if (sub.includes("gif")) {
        title = "GIF image";
      } else {
        title = `${sub.toUpperCase()} image`;
      }
    }
    return { title };
  }

  if (trimmed.startsWith("<svg") || (trimmed.startsWith("<?xml") && trimmed.includes("<svg"))) {
    const titleMatch = trimmed.match(/<title[^>]*>([^<]+)<\/title>/i);
    let title = "SVG image";
    if (titleMatch && titleMatch[1]) {
      const extracted = titleMatch[1].trim();
      if (extracted.length > 0) {
        title = extracted;
      }
    }
    return { title };
  }

  return null;
}

interface UrlMatch {
  readonly host: string;
  readonly title: string;
}

function tryMatchUrl(trimmed: string): UrlMatch | null {
  if (/\s/.test(trimmed)) {
    return null;
  }

  const candidate = trimmed.startsWith("www.") ? `https://${trimmed}` : trimmed;
  if (!/^https?:\/\//i.test(candidate) && !/^ftp:\/\//i.test(candidate)) {
    return null;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "ftp:") {
      return null;
    }
    if (!parsed.host) {
      return null;
    }
    const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : parsed.host;
    return {
      host: parsed.host,
      title: path,
    };
  } catch {
    return null;
  }
}

interface JsonMatch {
  readonly title: string;
}

function tryMatchJson(trimmed: string, lines: readonly string[]): JsonMatch | null {
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }

    let title = "";
    if (!Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      if (keys.length > 0) {
        title = keys[0]!;
      }
    } else if (parsed.length > 0) {
      const firstItem = parsed[0];
      if (firstItem !== null && typeof firstItem === "object" && !Array.isArray(firstItem)) {
        const keys = Object.keys(firstItem);
        if (keys.length > 0) {
          title = keys[0]!;
        }
      }
    }

    if (title.length === 0) {
      title = findFirstMeaningfulLine(lines) ?? "JSON data";
    }

    return { title };
  } catch {
    return null;
  }
}

interface CsvMatch {
  readonly title: string;
}

function parseDelimitedRow(line: string, delimiter: string): readonly string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

function cleanCsvHeader(header: string): string {
  let cleaned = header.trim();
  if (cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.length >= 2) {
    cleaned = cleaned.slice(1, -1).replace(/""/g, '"').trim();
  }
  return cleaned;
}

function tryMatchCsv(lines: readonly string[]): CsvMatch | null {
  const nonEmptyLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      nonEmptyLines.push(trimmed);
    }
  }

  if (nonEmptyLines.length < 2) {
    return null;
  }

  const sampleLimit = Math.min(nonEmptyLines.length, 50);
  const sample = nonEmptyLines.slice(0, sampleLimit);

  const delimiters = [",", "\t", ";"];
  for (const delim of delimiters) {
    if (delim === ";") {
      let looksLikeCode = false;
      for (const line of sample) {
        if (/^(?:const|let|var|function|import|export|class|if|for|while|return)\b/.test(line)) {
          looksLikeCode = true;
          break;
        }
      }
      if (looksLikeCode) {
        continue;
      }
    }

    const firstLine = sample[0]!;
    const firstRow = parseDelimitedRow(firstLine, delim);
    if (firstRow.length < 2) {
      continue;
    }

    const expectedColumns = firstRow.length;
    let consistent = true;
    for (let i = 1; i < sample.length; i++) {
      const row = parseDelimitedRow(sample[i]!, delim);
      if (row.length !== expectedColumns) {
        consistent = false;
        break;
      } 
    }

    if (!consistent) {
      continue;
    }

    if (delim === ";" && firstRow[firstRow.length - 1] === "") {
      continue;
    }

    const firstHeaderRaw = firstRow[0]!;
    const header = cleanCsvHeader(firstHeaderRaw);
    const title = header.length > 0 ? header : "CSV data";
    return { title };
  }

  return null;
}

interface CodeMatch {
  readonly language: string | null;
  readonly title: string;
}

function normalizeLanguage(raw: string): string {
  const lower = raw.toLowerCase();
  switch (lower) {
    case "ts":
    case "typescript":
      return "typescript";
    case "js":
    case "javascript":
      return "javascript";
    case "py":
    case "python":
      return "python";
    case "rs":
    case "rust":
      return "rust";
    case "go":
    case "golang":
      return "go";
    case "rb":
    case "ruby":
      return "ruby";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    case "yml":
    case "yaml":
      return "yaml";
    case "json":
      return "json";
    case "html":
      return "html";
    case "css":
      return "css";
    case "sql":
      return "sql";
    case "c":
      return "c";
    case "cpp":
    case "c++":
      return "cpp";
    case "java":
      return "java";
    case "md":
    case "markdown":
      return "markdown";
    default:
      return lower;
  }
}

function guessLanguage(text: string, lines: readonly string[]): string | null {
  if (lines.length > 0) {
    const firstLine = lines[0]!.trim();
    if (firstLine.startsWith("#!")) {
      if (/python/i.test(firstLine)) return "python";
      if (/node/i.test(firstLine)) return "javascript";
      if (/bash/i.test(firstLine)) return "bash";
      if (/\/sh\b/i.test(firstLine)) return "sh";
      if (/ruby/i.test(firstLine)) return "ruby";
      if (/perl/i.test(firstLine)) return "perl";
      if (/php/i.test(firstLine)) return "php";
    }
  }

  const hasTsSyntax =
    /\b(?:interface\s+\w+|type\s+\w+\s*=|enum\s+\w+)\b/.test(text) ||
    /:\s*(?:string|number|boolean|any|unknown|void|never|object)\b/.test(text) ||
    /\bas\s+const\b/.test(text) ||
    /<[A-Z]\w*(?:\s*,\s*[A-Z]\w*)*>/.test(text);

  const hasJsSyntax =
    /\b(?:console\.(?:log|warn|error)|const\s+\w+|let\s+\w+|var\s+\w+|function\s+\w+|async\s+function|export\s+|import\s+.*from)\b/.test(text);

  if (hasTsSyntax) {
    return "typescript";
  }
  if (hasJsSyntax) {
    return "javascript";
  }

  if (
    /^\s*(?:def\s+\w+\s*\(|class\s+\w+.*:|from\s+\w+\s+import|import\s+\w+)/m.test(text) &&
    (text.includes("def ") || text.includes("print(") || text.includes("elif ") || text.includes("self."))
  ) {
    return "python";
  }

  if (/\b(?:fn\s+main|pub\s+fn|let\s+mut\s+|impl\s+\w+|println!|use\s+std::)\b/.test(text)) {
    return "rust";
  }

  if (
    /^\s*package\s+\w+/m.test(text) ||
    /^\s*func\s+(?:\([^)]+\)\s*)?\w+\(/m.test(text) ||
    /\bfmt\.Print/.test(text)
  ) {
    return "go";
  }

  if (/<!DOCTYPE\s+html|<html[\s>]|<\/html>/i.test(text)) {
    return "html";
  }

  if (/@media|@keyframes|\b[\w-]+\s*:\s*[^;]+;\s*\}/.test(text)) {
    return "css";
  }

  if (/\bSELECT\b[\s\S]+\bFROM\b|\bINSERT\s+INTO\b|\bCREATE\s+TABLE\b|\bUPDATE\s+\w+\s+SET\b/i.test(text)) {
    return "sql";
  }

  if (/#include\s+<iostream>/.test(text)) return "cpp";
  if (/#include\s+<[a-z_.]+\.h>/.test(text)) return "c";

  if (/^\s*(?:echo\s+["']|export\s+[A-Z_]+=|chmod\s+[+0-9])/m.test(text)) {
    return "bash";
  }

  return null;
}

function tryMatchCode(trimmed: string, lines: readonly string[]): CodeMatch | null {
  const fenceMatch = trimmed.match(/^(`{3,}|~{3,})([^\n]*)/);
  if (fenceMatch) {
    const rawTag = (fenceMatch[2] ?? "").trim().split(/\s+/)[0] ?? "";
    let language: string | null = rawTag.length > 0 ? normalizeLanguage(rawTag) : null;

    let firstCodeLine: string | null = null;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      const lineTrim = line.trim();
      if (lineTrim.startsWith("```") || lineTrim.startsWith("~~~")) {
        break;
      }
      if (lineTrim.length > 0) {
        firstCodeLine = lineTrim;
        break;
      }
    }

    if (!language) {
      language = guessLanguage(trimmed, lines);
    }

    const title = firstCodeLine ?? "Code snippet";
    return { language, title };
  }

  if (lines.length > 0 && lines[0]!.trim().startsWith("#!")) {
    const language = guessLanguage(trimmed, lines);
    const title = lines[0]!.trim();
    return { language, title };
  }

  const isCodeStructure =
    /^\s*(?:(?:export|public|private|protected|static|async)\s+)*(?:function\s+\w+|class\s+\w+|interface\s+\w+|type\s+\w+\s*=|enum\s+\w+)/m.test(trimmed) ||
    /^\s*(?:import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"][^'"]+['"]|export\s+(?:default\s+|const\s+|let\s+|var\s+))/m.test(trimmed) ||
    /^\s*(?:const|let|var)\s+\w+\s*=\s*(?:\([^)]*\)|\w+)\s*=>/m.test(trimmed) ||
    /^\s*(?:async\s+)?def\s+\w+\s*\([^)]*\)\s*:/m.test(trimmed) ||
    /^\s*class\s+\w+(?:\([^)]*\))?\s*:/m.test(trimmed) ||
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:fn|impl|struct|enum|trait)\s+\w+/m.test(trimmed) ||
    /^\s*(?:package\s+\w+|func\s+(?:\([^)]+\)\s*)?\w+\s*\()/m.test(trimmed) ||
    /^\s*#include\s+[<"][^>"]+[>"]/m.test(trimmed) ||
    /^\s*<!DOCTYPE\s+html|<html[\s>]|<\/html>/im.test(trimmed) ||
    /^\s*(?:SELECT\s+.+\s+FROM\s+\w+|INSERT\s+INTO\s+\w+|CREATE\s+TABLE\s+\w+|UPDATE\s+\w+\s+SET\s+)/im.test(trimmed);

  if (isCodeStructure) {
    const language = guessLanguage(trimmed, lines);
    const title = findFirstMeaningfulLine(lines) ?? "Code snippet";
    return { language, title };
  }

  return null;
}

interface MarkdownMatch {
  readonly title: string;
}

function tryMatchMarkdown(lines: readonly string[]): MarkdownMatch | null {
  let headingTitle: string | null = null;
  let hasMarkdownSignals = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    const atxMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (atxMatch && atxMatch[1]) {
      hasMarkdownSignals = true;
      if (!headingTitle) {
        headingTitle = atxMatch[1].trim();
      }
      continue;
    }

    if (i + 1 < lines.length && trimmed.length > 0) {
      const nextTrimmed = lines[i + 1]!.trim();
      if (/^={3,}$/.test(nextTrimmed) || /^-{3,}$/.test(nextTrimmed)) {
        hasMarkdownSignals = true;
        if (!headingTitle) {
          headingTitle = trimmed;
        }
        continue;
      }
    }

    if (/^[-*+]\s+\S+/.test(trimmed) || /^\d+\.\s+\S+/.test(trimmed)) {
      hasMarkdownSignals = true;
      continue;
    }

    if (/^>\s+\S+/.test(trimmed) || /^---$|^\*\*\*$|^___$/.test(trimmed)) {
      hasMarkdownSignals = true;
      continue;
    }
  }

  if (!hasMarkdownSignals) {
    return null;
  }

  if (headingTitle) {
    return { title: headingTitle };
  }

  const firstLine = findFirstMeaningfulLine(lines);
  if (firstLine) {
    const cleaned = firstLine.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "").trim();
    return { title: cleaned.length > 0 ? cleaned : firstLine };
  }

  return { title: "Markdown document" };
}

export function analysePaste(text: string): PasteAnalysis {
  const chars = text.length;
  const lines = text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
  const preview = text.slice(0, PREVIEW_CHARS);

  const rawLines = text.split(/\r\n|\r|\n/);
  const trimmed = text.trim();

  const imageMatch = tryMatchImage(trimmed);
  if (imageMatch) {
    const title = formatTitle(imageMatch.title);
    const warnings = collectWarnings(text, rawLines, "image");
    return {
      kind: "image",
      title,
      preview,
      chars,
      lines,
      language: null,
      host: null,
      warnings,
    };
  }

  const urlMatch = tryMatchUrl(trimmed);
  if (urlMatch) {
    const title = formatTitle(urlMatch.title);
    const warnings = collectWarnings(text, rawLines, "url");
    return {
      kind: "url",
      title,
      preview,
      chars,
      lines,
      language: null,
      host: urlMatch.host,
      warnings,
    };
  }

  const jsonMatch = tryMatchJson(trimmed, rawLines);
  if (jsonMatch) {
    const title = formatTitle(jsonMatch.title);
    const warnings = collectWarnings(text, rawLines, "json");
    return {
      kind: "json",
      title,
      preview,
      chars,
      lines,
      language: null,
      host: null,
      warnings,
    };
  }

  const csvMatch = tryMatchCsv(rawLines);
  if (csvMatch) {
    const title = formatTitle(csvMatch.title);
    const warnings = collectWarnings(text, rawLines, "csv");
    return {
      kind: "csv",
      title,
      preview,
      chars,
      lines,
      language: null,
      host: null,
      warnings,
    };
  }

  const codeMatch = tryMatchCode(trimmed, rawLines);
  if (codeMatch) {
    const title = formatTitle(codeMatch.title);
    const warnings = collectWarnings(text, rawLines, "code");
    return {
      kind: "code",
      title,
      preview,
      chars,
      lines,
      language: codeMatch.language,
      host: null,
      warnings,
    };
  }

  const markdownMatch = tryMatchMarkdown(rawLines);
  if (markdownMatch) {
    const title = formatTitle(markdownMatch.title);
    const warnings = collectWarnings(text, rawLines, "markdown");
    return {
      kind: "markdown",
      title,
      preview,
      chars,
      lines,
      language: null,
      host: null,
      warnings,
    };
  }

  const firstMeaningful = findFirstMeaningfulLine(rawLines);
  const title = formatTitle(firstMeaningful ?? "Pasted text");
  const warnings = collectWarnings(text, rawLines, "text");

  return {
    kind: "text",
    title,
    preview,
    chars,
    lines,
    language: null,
    host: null,
    warnings,
  };
}
