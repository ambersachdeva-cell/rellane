/**
 * Deterministic workstation artifact extraction.
 * Extracts complete fenced code blocks, Markdown tables, and structured documents
 * as candidate artifacts without remote rendering or executing code/HTML.
 * Exports produce candidates only and never auto-accept.
 */

export interface ExtractedArtifact {
  readonly title: string;
  readonly body: string;
  readonly language: string | null;
  readonly kind: "document" | "code" | "table";
}

const MAX_BODY_LENGTH = 50_000;
const MAX_TITLE_LENGTH = 120;

function cleanTitle(raw: string, fallback: string): string {
  const stripped = raw
    .replace(/^#+\s*/, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/^__|_$/g, "")
    .replace(/[`'"]/g, "")
    .trim();
  if (stripped.length === 0) return fallback;
  if (stripped.length > MAX_TITLE_LENGTH) {
    return stripped.slice(0, MAX_TITLE_LENGTH - 3).trim() + "...";
  }
  return stripped;
}

function boundBody(raw: string): string {
  if (raw.length <= MAX_BODY_LENGTH) {
    return raw;
  }
  return raw.slice(0, MAX_BODY_LENGTH);
}

interface CodeFence {
  readonly startLine: number;
  readonly endLine: number;
  readonly language: string | null;
  readonly body: string;
  readonly title: string;
}

function extractCompleteCodeFences(lines: readonly string[]): {
  readonly fences: readonly CodeFence[];
  readonly codeLineIndices: ReadonlySet<number>;
} {
  const fences: CodeFence[] = [];
  const codeLineIndices = new Set<number>();

  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let openLineIdx = -1;
  let rawInfo = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (!inFence) {
      const match = line.match(/^[ ]{0,3}(`{3,}|~{3,})(.*)$/);
      if (match && match[1]) {
        inFence = true;
        fenceChar = match[1][0]!;
        fenceLen = match[1].length;
        openLineIdx = i;
        rawInfo = match[2] ?? "";
      }
    } else {
      const closeMatch = line.match(/^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/);
      if (
        closeMatch &&
        closeMatch[1] &&
        closeMatch[1][0] === fenceChar &&
        closeMatch[1].length >= fenceLen
      ) {
        for (let l = openLineIdx; l <= i; l++) {
          codeLineIndices.add(l);
        }

        const bodyLines = lines.slice(openLineIdx + 1, i);
        const body = bodyLines.join("\n");

        const infoTrimmed = rawInfo.trim();
        const firstToken = infoTrimmed.split(/[\s:=]+/)[0]?.toLowerCase() || "";
        const cleanLang = firstToken.replace(/[^a-z0-9_-]/g, "");
        const language = cleanLang.length > 0 ? cleanLang : null;

        let inferredTitle = "";

        const attrMatch = infoTrimmed.match(
          /(?:title|filename|file)=["']?([^"'\s]+)["']?/i
        );
        if (attrMatch && attrMatch[1]) {
          inferredTitle = attrMatch[1];
        }

        if (!inferredTitle && openLineIdx > 0) {
          for (let lookback = openLineIdx - 1; lookback >= Math.max(0, openLineIdx - 3); lookback--) {
            const prevLine = lines[lookback]!.trim();
            if (prevLine.length === 0) continue;
            const headingMatch = prevLine.match(/^#{1,6}\s+(.+)$/);
            if (headingMatch && headingMatch[1]) {
              inferredTitle = headingMatch[1];
              break;
            }
            const boldMatch = prevLine.match(/^\*\*(.+)\*\*$/);
            if (boldMatch && boldMatch[1]) {
              inferredTitle = boldMatch[1];
              break;
            }
            const labelMatch = prevLine.match(/^(?:File|Filename|Source):\s*`?([^`]+)`?$/i);
            if (labelMatch && labelMatch[1]) {
              inferredTitle = labelMatch[1];
              break;
            }
            break;
          }
        }

        if (!inferredTitle) {
          for (const bl of bodyLines.slice(0, 3)) {
            const commentMatch = bl
              .trim()
              .match(/^(?:\/\/|#|--|\/\*|<!--)\s*(?:File:\s*|Filename:\s*)?([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)/i);
            if (commentMatch && commentMatch[1]) {
              inferredTitle = commentMatch[1];
              break;
            }
          }
        }

        const fallbackTitle = language
          ? `${language.charAt(0).toUpperCase() + language.slice(1)} snippet`
          : "Code snippet";
        const title = cleanTitle(inferredTitle, fallbackTitle);

        if (body.trim().length > 0) {
          fences.push({
            startLine: openLineIdx,
            endLine: i,
            language,
            body: boundBody(body),
            title
          });
        }

        inFence = false;
        fenceChar = "";
        fenceLen = 0;
        openLineIdx = -1;
        rawInfo = "";
      }
    }
  }

  if (inFence && openLineIdx >= 0) {
    for (let l = openLineIdx; l < lines.length; l++) {
      codeLineIndices.add(l);
    }
  }

  return { fences, codeLineIndices };
}

function isTableDelimiterRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("-") || !trimmed.includes("|")) return false;
  const stripped = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = stripped.split("|");
  if (cells.length < 2) return false;
  return cells.every((cell) => /^\s*:?-{2,}:?\s*$/.test(cell));
}

function extractMarkdownTables(
  lines: readonly string[],
  codeLineIndices: ReadonlySet<number>
): readonly ExtractedArtifact[] {
  const tables: ExtractedArtifact[] = [];
  let i = 0;

  while (i < lines.length) {
    if (codeLineIndices.has(i)) {
      i++;
      continue;
    }

    const currentLine = lines[i]!.trim();
    const nextLine = i + 1 < lines.length ? lines[i + 1]!.trim() : "";

    if (
      currentLine.includes("|") &&
      !codeLineIndices.has(i + 1) &&
      isTableDelimiterRow(nextLine)
    ) {
      const tableStartIdx = i;
      let tableEndIdx = i + 1;

      while (
        tableEndIdx + 1 < lines.length &&
        !codeLineIndices.has(tableEndIdx + 1)
      ) {
        const rowCandidate = lines[tableEndIdx + 1]!.trim();
        if (rowCandidate.includes("|") && rowCandidate.length > 0) {
          tableEndIdx++;
        } else {
          break;
        }
      }

      if (tableEndIdx >= tableStartIdx + 2) {
        const tableLines = lines.slice(tableStartIdx, tableEndIdx + 1);
        const body = boundBody(tableLines.join("\n"));

        let tableTitle = "";
        for (let lookback = tableStartIdx - 1; lookback >= Math.max(0, tableStartIdx - 3); lookback--) {
          const prevLine = lines[lookback]!.trim();
          if (prevLine.length === 0) continue;
          const headingMatch = prevLine.match(/^#{1,6}\s+(.+)$/);
          if (headingMatch && headingMatch[1]) {
            tableTitle = headingMatch[1];
            break;
          }
          const boldMatch = prevLine.match(/^\*\*(.+)\*\*$/);
          if (boldMatch && boldMatch[1]) {
            tableTitle = boldMatch[1];
            break;
          }
          const labelMatch = prevLine.match(/^(?:Table|Summary):\s*(.+)$/i);
          if (labelMatch && labelMatch[1]) {
            tableTitle = labelMatch[1];
            break;
          }
          break;
        }

        if (!tableTitle) {
          const headerCells = currentLine
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((c) => c.trim())
            .filter((c) => c.length > 0);
          if (headerCells.length > 0) {
            tableTitle = `Table: ${headerCells.slice(0, 3).join(", ")}`;
          } else {
            tableTitle = "Data Table";
          }
        }

        tables.push({
          title: cleanTitle(tableTitle, "Data Table"),
          body,
          language: null,
          kind: "table"
        });

        i = tableEndIdx + 1;
        continue;
      }
    }

    i++;
  }

  return tables;
}

function extractMarkdownDocument(
  text: string,
  lines: readonly string[],
  codeLineIndices: ReadonlySet<number>,
  hasCodeOrTable: boolean
): ExtractedArtifact | null {
  const trimmedText = text.trim();
  if (trimmedText.length === 0) return null;

  const nonCodeLines = lines.filter((_, idx) => !codeLineIndices.has(idx));
  const nonCodeContent = nonCodeLines.join("\n").trim();

  if (hasCodeOrTable && nonCodeContent.length < 50) {
    return null;
  }

  let docTitle = "";
  for (const line of lines) {
    const headingMatch = line.trim().match(/^#\s+(.+)$/);
    if (headingMatch && headingMatch[1]) {
      docTitle = headingMatch[1];
      break;
    }
  }

  if (!docTitle) {
    for (const line of lines) {
      const headingMatch = line.trim().match(/^##\s+(.+)$/);
      if (headingMatch && headingMatch[1]) {
        docTitle = headingMatch[1];
        break;
      }
    }
  }

  const hasHeadings = /^#{1,6}\s+/m.test(trimmedText);
  const paragraphCount = trimmedText.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length;

  if (!hasHeadings && paragraphCount < 2 && trimmedText.length < 150) {
    return null;
  }

  if (!docTitle) {
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.length > 0 && !trimmedLine.startsWith("```")) {
        docTitle = cleanTitle(trimmedLine, "Document");
        break;
      }
    }
  }

  return {
    title: cleanTitle(docTitle, "Document"),
    body: boundBody(trimmedText),
    language: "markdown",
    kind: "document"
  };
}

export function extractWorkstationArtifacts(
  text: string
): readonly ExtractedArtifact[] {
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return [];
  }

  const lines = text.split(/\r?\n/);
  const { fences, codeLineIndices } = extractCompleteCodeFences(lines);
  const tables = extractMarkdownTables(lines, codeLineIndices);

  const hasCodeOrTable = fences.length > 0 || tables.length > 0;
  const document = extractMarkdownDocument(
    text,
    lines,
    codeLineIndices,
    hasCodeOrTable
  );

  const results: ExtractedArtifact[] = [];

  if (document) {
    results.push(document);
  }

  for (const fence of fences) {
    results.push({
      title: fence.title,
      body: fence.body,
      language: fence.language,
      kind: "code"
    });
  }

  for (const table of tables) {
    results.push(table);
  }

  return results;
}
