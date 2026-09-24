/**
 * Multi-format publication engine for Rellane Workstation.
 * Transforms workstation notes, data tables, and structured summaries into
 * standalone HTML briefs, interactive slide decks, Typst layout sources,
 * and GitHub-Flavored Markdown reports.
 */

export type PublicationFormat = "html" | "slides" | "typst" | "markdown";

export interface PublicationSection {
  readonly heading: string;
  readonly content: string;
  readonly subheadings?: readonly { readonly title: string; readonly body: string }[];
  readonly callout?: { readonly type: "note" | "warning" | "metric"; readonly text: string };
}

export interface PublicationRequest {
  readonly format: PublicationFormat;
  readonly title: string;
  readonly subtitle?: string;
  readonly author?: string;
  readonly date?: string;
  readonly sections: readonly PublicationSection[];
  readonly theme?: "graphite" | "editorial" | "classic";
}

export interface PublicationResult {
  readonly format: PublicationFormat;
  readonly filename: string;
  readonly mimeType: string;
  readonly content: string;
  readonly pageCountEstimate?: number;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^(?:https?:\/\/|mailto:|#|\/|\.)/i.test(trimmed)) {
    return escapeHtml(trimmed);
  }
  return "#";
}

function formatInlineHtml(text: string): string {
  let escaped = escapeHtml(text);

  escaped = escaped.replace(/`([^`]+)`/g, (_match, code: string) => `<code>${code}</code>`);
  escaped = escaped.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  escaped = escaped.replace(/___([^_]+)___/g, "<strong><em>$1</em></strong>");
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  escaped = escaped.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  escaped = escaped.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  escaped = escaped.replace(/\b_([^_]+)_\b/g, "<em>$1</em>");
  escaped = escaped.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
    const safe = sanitizeUrl(url);
    return `<a href="${safe}">${label}</a>`;
  });

  return escaped;
}

function parseMarkdownToHtml(markdown: string): string {
  const trimmed = markdown.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const lines = markdown.split(/\r?\n/);
  const htmlBlocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const currentLine = lines[i];
    if (currentLine === undefined) {
      i++;
      continue;
    }

    const trimmedLine = currentLine.trim();
    if (trimmedLine.length === 0) {
      i++;
      continue;
    }

    if (trimmedLine.startsWith("```")) {
      const language = trimmedLine.slice(3).trim().split(/\s+/)[0] ?? "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const cLine = lines[i];
        if (cLine === undefined) {
          i++;
          continue;
        }
        if (cLine.trim().startsWith("```")) {
          i++;
          break;
        }
        codeLines.push(escapeHtml(cLine));
        i++;
      }
      const langClass = language.length > 0 ? ` class="language-${escapeHtml(language)}"` : "";
      htmlBlocks.push(`<pre><code${langClass}>${codeLines.join("\n")}</code></pre>`);
      continue;
    }

    if (/^(?:---|\*\*\*|___)\s*$/.test(trimmedLine)) {
      htmlBlocks.push("<hr />");
      i++;
      continue;
    }

    const headingMatch = trimmedLine.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const hashes = headingMatch[1];
      const headingText = headingMatch[2];
      if (hashes !== undefined && headingText !== undefined) {
        const level = hashes.length;
        htmlBlocks.push(`<h${level}>${formatInlineHtml(headingText)}</h${level}>`);
        i++;
        continue;
      }
    }

    if (trimmedLine.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const qLine = lines[i];
        if (qLine === undefined) break;
        const qTrim = qLine.trim();
        if (qTrim.startsWith(">")) {
          quoteLines.push(qTrim.replace(/^>\s?/, ""));
          i++;
        } else if (qTrim.length === 0) {
          break;
        } else {
          quoteLines.push(qTrim);
          i++;
        }
      }
      const quoteContent = quoteLines.map((l) => formatInlineHtml(l)).join("<br />");
      htmlBlocks.push(`<blockquote><p>${quoteContent}</p></blockquote>`);
      continue;
    }

    if (trimmedLine.includes("|") && i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      if (nextLine !== undefined && /^\s*\|?\s*:?-+:?\s*\|/.test(nextLine)) {
        const headerRow = trimmedLine;
        i += 2;
        const bodyRows: string[] = [];
        while (i < lines.length) {
          const tLine = lines[i];
          if (tLine === undefined) break;
          const tTrim = tLine.trim();
          if (!tTrim.includes("|") || tTrim.length === 0) {
            break;
          }
          bodyRows.push(tTrim);
          i++;
        }

        const splitRow = (row: string): string[] => {
          let r = row.trim();
          if (r.startsWith("|")) r = r.slice(1);
          if (r.endsWith("|")) r = r.slice(0, -1);
          return r.split("|").map((c) => c.trim());
        };

        const headers = splitRow(headerRow);
        const headerHtml = `<thead><tr>${headers.map((h) => `<th>${formatInlineHtml(h)}</th>`).join("")}</tr></thead>`;
        const bodyRowsHtml = bodyRows
          .map((row) => {
            const cells = splitRow(row);
            return `<tr>${cells.map((c) => `<td>${formatInlineHtml(c)}</td>`).join("")}</tr>`;
          })
          .join("");
        const bodyHtml = bodyRows.length > 0 ? `<tbody>${bodyRowsHtml}</tbody>` : "";
        htmlBlocks.push(`<table>${headerHtml}${bodyHtml}</table>`);
        continue;
      }
    }

    if (/^[-*]\s+/.test(trimmedLine)) {
      const items: string[] = [];
      while (i < lines.length) {
        const uLine = lines[i];
        if (uLine === undefined) break;
        const uTrim = uLine.trim();
        const itemMatch = uTrim.match(/^[-*]\s+(.*)$/);
        if (itemMatch) {
          const itemText = itemMatch[1];
          if (itemText !== undefined) {
            items.push(`<li>${formatInlineHtml(itemText)}</li>`);
          }
          i++;
        } else if (uTrim.length === 0) {
          break;
        } else {
          if (items.length > 0) {
            const lastIdx = items.length - 1;
            const prev = items[lastIdx]!;
            items[lastIdx] = prev.replace(/<\/li>$/, ` ${formatInlineHtml(uTrim)}</li>`);
          }
          i++;
        }
      }
      htmlBlocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmedLine)) {
      const items: string[] = [];
      while (i < lines.length) {
        const oLine = lines[i];
        if (oLine === undefined) break;
        const oTrim = oLine.trim();
        const itemMatch = oTrim.match(/^\d+\.\s+(.*)$/);
        if (itemMatch) {
          const itemText = itemMatch[1];
          if (itemText !== undefined) {
            items.push(`<li>${formatInlineHtml(itemText)}</li>`);
          }
          i++;
        } else if (oTrim.length === 0) {
          break;
        } else {
          if (items.length > 0) {
            const lastIdx = items.length - 1;
            const prev = items[lastIdx]!;
            items[lastIdx] = prev.replace(/<\/li>$/, ` ${formatInlineHtml(oTrim)}</li>`);
          }
          i++;
        }
      }
      htmlBlocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    const pLines: string[] = [];
    while (i < lines.length) {
      const pLine = lines[i];
      if (pLine === undefined) break;
      const pTrim = pLine.trim();
      if (pTrim.length === 0) {
        i++;
        break;
      }
      if (
        pTrim.startsWith("```") ||
        pTrim.startsWith(">") ||
        /^(?:---|\*\*\*|___)\s*$/.test(pTrim) ||
        /^#{1,6}\s+/.test(pTrim) ||
        /^[-*]\s+/.test(pTrim) ||
        /^\d+\.\s+/.test(pTrim) ||
        (pTrim.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*\|/.test(lines[i + 1] ?? ""))
      ) {
        break;
      }
      pLines.push(pTrim);
      i++;
    }
    if (pLines.length > 0) {
      htmlBlocks.push(`<p>${pLines.map((l) => formatInlineHtml(l)).join(" ")}</p>`);
    }
  }

  return htmlBlocks.join("\n");
}

function renderCalloutHtml(callout: { readonly type: "note" | "warning" | "metric"; readonly text: string }): string {
  const type = callout.type;
  const label = type === "note" ? "Note" : type === "warning" ? "Warning" : "Metric";
  const icon = type === "note" ? "i" : type === "warning" ? "!" : "#";
  return [
    `<aside class="pub-callout pub-callout-${type}">`,
    `  <div class="pub-callout-header">`,
    `    <span class="pub-callout-icon" aria-hidden="true">${icon}</span>`,
    `    <span class="pub-callout-label">${label}</span>`,
    `  </div>`,
    `  <div class="pub-callout-body">${formatInlineHtml(callout.text)}</div>`,
    `</aside>`
  ].join("\n");
}

function renderSubheadingsHtml(subheadings?: readonly { readonly title: string; readonly body: string }[]): string {
  if (!subheadings || subheadings.length === 0) {
    return "";
  }
  return subheadings
    .map(
      (sub) =>
        `<div class="pub-subheading">\n  <h3 class="pub-subheading-title">${formatInlineHtml(
          sub.title
        )}</h3>\n  <div class="pub-subheading-body">${parseMarkdownToHtml(sub.body)}</div>\n</div>`
    )
    .join("\n");
}

function getHtmlDocumentCss(theme: "graphite" | "editorial" | "classic"): string {
  return `* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

:root {
  --font-sans: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-serif: "IBM Plex Serif", Georgia, Cambria, "Times New Roman", serif;
  --font-mono: "IBM Plex Mono", SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

body {
  margin: 0;
  padding: 0;
  background-color: var(--bg-color);
  color: var(--text-main);
  font-family: var(--body-font);
  font-size: 15px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}

body.theme-graphite {
  --bg-color: #fafafa;
  --card-bg: #ffffff;
  --text-main: #18181b;
  --text-muted: #71717a;
  --border-color: #e4e4e7;
  --accent-color: #27272a;
  --code-bg: #f4f4f5;
  --callout-note-bg: #f4f4f5;
  --callout-note-border: #71717a;
  --callout-note-text: #27272a;
  --callout-warning-bg: #fef2f2;
  --callout-warning-border: #ef4444;
  --callout-warning-text: #991b1b;
  --callout-metric-bg: #f0fdf4;
  --callout-metric-border: #22c55e;
  --callout-metric-text: #166534;
  --body-font: var(--font-sans);
}

body.theme-editorial {
  --bg-color: #fdfbf7;
  --card-bg: #ffffff;
  --text-main: #262626;
  --text-muted: #737373;
  --border-color: #e5e5e5;
  --accent-color: #78350f;
  --code-bg: #f5f5f4;
  --callout-note-bg: #fbfaf8;
  --callout-note-border: #a8a29e;
  --callout-note-text: #44403c;
  --callout-warning-bg: #fffbeb;
  --callout-warning-border: #d97706;
  --callout-warning-text: #92400e;
  --callout-metric-bg: #f0fdfa;
  --callout-metric-border: #0d9488;
  --callout-metric-text: #115e59;
  --body-font: var(--font-serif);
}

body.theme-classic {
  --bg-color: #ffffff;
  --card-bg: #ffffff;
  --text-main: #0f172a;
  --text-muted: #64748b;
  --border-color: #cbd5e1;
  --accent-color: #1e3a8a;
  --code-bg: #f1f5f9;
  --callout-note-bg: #f8fafc;
  --callout-note-border: #3b82f6;
  --callout-note-text: #1e293b;
  --callout-warning-bg: #fff7ed;
  --callout-warning-border: #f97316;
  --callout-warning-text: #9a3412;
  --callout-metric-bg: #eff6ff;
  --callout-metric-border: #2563eb;
  --callout-metric-text: #1e40af;
  --body-font: var(--font-sans);
}

.pub-container {
  max-width: 820px;
  margin: 40px auto;
  padding: 48px 56px;
  background-color: var(--card-bg);
  border: 1px solid var(--border-color);
  border-radius: 6px;
}

.pub-header {
  margin-bottom: 24px;
}

.pub-title {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.25;
  color: var(--text-main);
  letter-spacing: -0.02em;
  margin-bottom: 8px;
}

.pub-subtitle {
  font-size: 17px;
  color: var(--text-muted);
  line-height: 1.4;
  margin-bottom: 12px;
}

.pub-meta {
  font-size: 13px;
  color: var(--text-muted);
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.pub-divider {
  border: 0;
  height: 1px;
  background-color: var(--border-color);
  margin: 24px 0 32px 0;
}

.pub-section {
  margin-bottom: 40px;
}

.pub-section-heading {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-main);
  letter-spacing: -0.01em;
  margin-bottom: 14px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-color);
}

.pub-section-content {
  margin-bottom: 16px;
}

.pub-section-content p {
  margin-bottom: 12px;
}

.pub-section-content p:last-child {
  margin-bottom: 0;
}

.pub-callout {
  margin: 16px 0;
  padding: 12px 16px;
  border-left: 3px solid;
  border-radius: 0 4px 4px 0;
  font-size: 14px;
}

.pub-callout-note {
  background-color: var(--callout-note-bg);
  border-left-color: var(--callout-note-border);
  color: var(--callout-note-text);
}

.pub-callout-warning {
  background-color: var(--callout-warning-bg);
  border-left-color: var(--callout-warning-border);
  color: var(--callout-warning-text);
}

.pub-callout-metric {
  background-color: var(--callout-metric-bg);
  border-left-color: var(--callout-metric-border);
  color: var(--callout-metric-text);
}

.pub-callout-header {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.pub-subheading {
  margin-top: 20px;
  padding-left: 16px;
  border-left: 2px solid var(--border-color);
}

.pub-subheading-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-main);
  margin-bottom: 6px;
}

.pub-subheading-body {
  font-size: 14px;
  color: var(--text-main);
}

table {
  width: 100%;
  border-collapse: collapse;
  margin: 16px 0;
  font-size: 14px;
}

th, td {
  padding: 8px 12px;
  text-align: left;
  border: 1px solid var(--border-color);
}

th {
  background-color: var(--code-bg);
  font-weight: 600;
}

pre {
  background-color: var(--code-bg);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 12px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 13px;
  margin: 16px 0;
}

code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background-color: var(--code-bg);
  padding: 2px 4px;
  border-radius: 3px;
}

pre code {
  background-color: transparent;
  padding: 0;
}

blockquote {
  border-left: 3px solid var(--border-color);
  padding: 8px 16px;
  margin: 16px 0;
  color: var(--text-muted);
  font-style: italic;
}

ul, ol {
  margin: 12px 0 12px 24px;
}

li {
  margin-bottom: 4px;
}

.pub-footer {
  margin-top: 48px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
  font-size: 12px;
  color: var(--text-muted);
  text-align: right;
}

@media print {
  @page {
    size: A4;
    margin: 20mm 15mm 20mm 15mm;
  }
  body {
    background: #ffffff !important;
    color: #000000 !important;
    font-size: 11pt !important;
  }
  .pub-container {
    max-width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
    border: none !important;
  }
  .pub-header, .pub-section-heading, h1, h2, h3 {
    page-break-after: avoid;
    break-after: avoid;
  }
  .pub-section {
    page-break-inside: auto;
    break-inside: auto;
  }
  .pub-callout, table, pre, blockquote {
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .pub-footer {
    display: none;
  }
}`;
}

export function generateHtmlDocument(request: PublicationRequest): string {
  const theme = request.theme ?? "graphite";
  const safeTitle = escapeHtml(request.title || "Document");
  const subtitleHtml = request.subtitle ? `<p class="pub-subtitle">${escapeHtml(request.subtitle)}</p>` : "";
  const metaItems: string[] = [];
  if (request.author) {
    metaItems.push(`<span class="pub-meta-item"><strong>Author:</strong> ${escapeHtml(request.author)}</span>`);
  }
  if (request.date) {
    metaItems.push(`<span class="pub-meta-item"><strong>Date:</strong> ${escapeHtml(request.date)}</span>`);
  }
  const metaHtml = metaItems.length > 0 ? `<div class="pub-meta">${metaItems.join(" • ")}</div>` : "";

  const sectionsHtml = request.sections
    .map((section) => {
      const headingHtml = `<h2 class="pub-section-heading">${escapeHtml(section.heading)}</h2>`;
      const calloutHtml = section.callout ? renderCalloutHtml(section.callout) : "";
      const contentHtml = parseMarkdownToHtml(section.content);
      const subheadingsHtml = renderSubheadingsHtml(section.subheadings);

      return [
        `<section class="pub-section">`,
        `  ${headingHtml}`,
        calloutHtml.length > 0 ? `  ${calloutHtml}` : "",
        `  <div class="pub-section-content">${contentHtml}</div>`,
        subheadingsHtml.length > 0 ? `  ${subheadingsHtml}` : "",
        `</section>`
      ]
        .filter((part) => part.length > 0)
        .join("\n");
    })
    .join("\n\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
${getHtmlDocumentCss(theme)}
  </style>
</head>
<body class="theme-${theme}">
  <main class="pub-container">
    <header class="pub-header">
      <h1 class="pub-title">${safeTitle}</h1>
      ${subtitleHtml}
      ${metaHtml}
    </header>
    <hr class="pub-divider" />
    <article class="pub-body">
      ${sectionsHtml}
    </article>
    <footer class="pub-footer">
      <span>Generated by Rellane Workstation</span>
    </footer>
  </main>
</body>
</html>`;
}

function getSlideDeckCss(theme: "graphite" | "editorial" | "classic"): string {
  return `* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

:root {
  --font-sans: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-serif: "IBM Plex Serif", Georgia, Cambria, "Times New Roman", serif;
  --font-mono: "IBM Plex Mono", SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

body {
  margin: 0;
  padding: 0;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background-color: var(--slide-bg);
  color: var(--slide-text);
  font-family: var(--slide-font);
  -webkit-font-smoothing: antialiased;
  transition: background-color 0.2s ease, color 0.2s ease;
}

body.theme-graphite {
  --slide-bg: #18181b;
  --slide-surface: #27272a;
  --slide-text: #f4f4f5;
  --slide-muted: #a1a1aa;
  --slide-border: #3f3f46;
  --slide-accent: #e4e4e7;
  --slide-progress: #71717a;
  --callout-note-bg: #27272a;
  --callout-note-border: #71717a;
  --callout-warning-bg: #451a1a;
  --callout-warning-border: #ef4444;
  --callout-metric-bg: #143522;
  --callout-metric-border: #22c55e;
  --slide-font: var(--font-sans);
}

body.theme-graphite.light-mode {
  --slide-bg: #f4f4f5;
  --slide-surface: #ffffff;
  --slide-text: #18181b;
  --slide-muted: #71717a;
  --slide-border: #e4e4e7;
  --slide-accent: #27272a;
  --slide-progress: #27272a;
  --callout-note-bg: #f4f4f5;
  --callout-note-border: #71717a;
  --callout-warning-bg: #fef2f2;
  --callout-warning-border: #ef4444;
  --callout-metric-bg: #f0fdf4;
  --callout-metric-border: #22c55e;
}

body.theme-editorial {
  --slide-bg: #fdfbf7;
  --slide-surface: #ffffff;
  --slide-text: #262626;
  --slide-muted: #737373;
  --slide-border: #e5e5e5;
  --slide-accent: #78350f;
  --slide-progress: #78350f;
  --callout-note-bg: #f5f5f4;
  --callout-note-border: #a8a29e;
  --callout-warning-bg: #fffbeb;
  --callout-warning-border: #d97706;
  --callout-metric-bg: #f0fdfa;
  --callout-metric-border: #0d9488;
  --slide-font: var(--font-serif);
}

body.theme-editorial.dark-mode {
  --slide-bg: #1c1917;
  --slide-surface: #292524;
  --slide-text: #f5f5f4;
  --slide-muted: #a8a29e;
  --slide-border: #44403c;
  --slide-accent: #d97706;
  --slide-progress: #d97706;
  --callout-note-bg: #292524;
  --callout-note-border: #78716c;
  --callout-warning-bg: #451a03;
  --callout-warning-border: #f59e0b;
  --callout-metric-bg: #042f2e;
  --callout-metric-border: #14b8a6;
}

body.theme-classic {
  --slide-bg: #0f172a;
  --slide-surface: #1e293b;
  --slide-text: #f8fafc;
  --slide-muted: #94a3b8;
  --slide-border: #334155;
  --slide-accent: #38bdf8;
  --slide-progress: #38bdf8;
  --callout-note-bg: #1e293b;
  --callout-note-border: #38bdf8;
  --callout-warning-bg: #431407;
  --callout-warning-border: #f97316;
  --callout-metric-bg: #022c22;
  --callout-metric-border: #10b981;
  --slide-font: var(--font-sans);
}

body.theme-classic.light-mode {
  --slide-bg: #ffffff;
  --slide-surface: #f8fafc;
  --slide-text: #0f172a;
  --slide-muted: #64748b;
  --slide-border: #cbd5e1;
  --slide-accent: #1e3a8a;
  --slide-progress: #1e3a8a;
  --callout-note-bg: #f1f5f9;
  --callout-note-border: #3b82f6;
  --callout-warning-bg: #fff7ed;
  --callout-warning-border: #f97316;
  --callout-metric-bg: #eff6ff;
  --callout-metric-border: #2563eb;
}

.deck-wrapper {
  position: relative;
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.deck-progress-track {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 3px;
  background: transparent;
  z-index: 100;
}

.deck-progress-bar {
  height: 100%;
  background-color: var(--slide-progress);
  transition: width 0.2s ease;
}

.deck-stage {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  overflow: hidden;
}

.slide {
  display: none;
  width: 100%;
  max-width: 1080px;
  height: 82vh;
  max-height: 720px;
  background-color: var(--slide-surface);
  border: 1px solid var(--slide-border);
  border-radius: 8px;
  padding: 48px 56px;
  flex-direction: column;
  justify-content: space-between;
  overflow-y: auto;
}

.slide.active {
  display: flex;
}

.slide-title-slide {
  text-align: center;
  justify-content: center;
  align-items: center;
}

.slide-main-title {
  font-size: 40px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 16px;
  line-height: 1.2;
}

.slide-subtitle {
  font-size: 22px;
  color: var(--slide-muted);
  margin-bottom: 24px;
}

.slide-meta {
  font-size: 15px;
  color: var(--slide-muted);
  display: flex;
  gap: 16px;
  justify-content: center;
}

.slide-hint {
  margin-top: 32px;
  font-size: 13px;
  color: var(--slide-muted);
  opacity: 0.7;
}

.slide-header {
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--slide-border);
}

.slide-heading {
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.slide-body {
  flex: 1;
  overflow-y: auto;
  font-size: 17px;
  line-height: 1.6;
}

.slide-footer {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--slide-border);
  font-size: 12px;
  color: var(--slide-muted);
  display: flex;
  justify-content: space-between;
}

table {
  width: 100%;
  border-collapse: collapse;
  margin: 16px 0;
  font-size: 15px;
}

th, td {
  padding: 8px 12px;
  text-align: left;
  border: 1px solid var(--slide-border);
}

th {
  background-color: var(--slide-bg);
  font-weight: 600;
}

pre {
  background-color: var(--slide-bg);
  border: 1px solid var(--slide-border);
  border-radius: 4px;
  padding: 12px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 14px;
  margin: 16px 0;
}

code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background-color: var(--slide-bg);
  padding: 2px 4px;
  border-radius: 3px;
}

pre code {
  background-color: transparent;
  padding: 0;
}

.deck-controls {
  position: fixed;
  bottom: 16px;
  right: 24px;
  display: flex;
  align-items: center;
  gap: 8px;
  background-color: var(--slide-surface);
  border: 1px solid var(--slide-border);
  padding: 6px 12px;
  border-radius: 20px;
  z-index: 90;
  font-size: 13px;
}

.deck-btn {
  background: transparent;
  border: none;
  color: var(--slide-text);
  font-size: 14px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}

.deck-btn:hover {
  background-color: var(--slide-bg);
}

.deck-counter {
  color: var(--slide-muted);
  font-variant-numeric: tabular-nums;
  padding: 0 4px;
}`;
}

function getSlideDeckScript(): string {
  return `(function() {
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var currentEl = document.getElementById('slide-current');
  var totalEl = document.getElementById('slide-total');
  var progressEl = document.getElementById('slide-progress');
  var prevBtn = document.getElementById('btn-prev');
  var nextBtn = document.getElementById('btn-next');
  var themeBtn = document.getElementById('btn-theme');

  var activeIndex = 0;

  function showSlide(index) {
    if (slides.length === 0) return;
    if (index < 0) index = 0;
    if (index >= slides.length) index = slides.length - 1;
    activeIndex = index;

    for (var i = 0; i < slides.length; i++) {
      var s = slides[i];
      if (i === activeIndex) {
        s.classList.add('active');
        s.setAttribute('aria-hidden', 'false');
      } else {
        s.classList.remove('active');
        s.setAttribute('aria-hidden', 'true');
      }
    }

    if (currentEl) currentEl.textContent = String(activeIndex + 1);
    if (totalEl) totalEl.textContent = String(slides.length);
    if (progressEl) {
      var pct = slides.length > 1 ? (activeIndex / (slides.length - 1)) * 100 : 100;
      progressEl.style.width = pct + '%';
    }
  }

  function nextSlide() {
    if (activeIndex < slides.length - 1) {
      showSlide(activeIndex + 1);
    }
  }

  function prevSlide() {
    if (activeIndex > 0) {
      showSlide(activeIndex - 1);
    }
  }

  function toggleTheme() {
    var body = document.body;
    if (body.classList.contains('light-mode')) {
      body.classList.remove('light-mode');
      body.classList.add('dark-mode');
    } else if (body.classList.contains('dark-mode')) {
      body.classList.remove('dark-mode');
      body.classList.add('light-mode');
    } else {
      body.classList.toggle('dark-mode');
    }
  }

  document.addEventListener('keydown', function(e) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      nextSlide();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      prevSlide();
    } else if (e.key === 'Home') {
      e.preventDefault();
      showSlide(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      showSlide(slides.length - 1);
    } else if (e.key === 't' || e.key === 'T') {
      toggleTheme();
    }
  });

  if (prevBtn) prevBtn.addEventListener('click', prevSlide);
  if (nextBtn) nextBtn.addEventListener('click', nextSlide);
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  showSlide(0);
})();`;
}

export function generateSlideDeckHtml(request: PublicationRequest): string {
  const theme = request.theme ?? "graphite";
  const safeTitle = escapeHtml(request.title || "Presentation");
  const subtitleHtml = request.subtitle ? `<p class="slide-subtitle">${escapeHtml(request.subtitle)}</p>` : "";
  const metaItems: string[] = [];
  if (request.author) {
    metaItems.push(`<span class="slide-meta-item"><strong>Author:</strong> ${escapeHtml(request.author)}</span>`);
  }
  if (request.date) {
    metaItems.push(`<span class="slide-meta-item"><strong>Date:</strong> ${escapeHtml(request.date)}</span>`);
  }
  const metaHtml = metaItems.length > 0 ? `<div class="slide-meta">${metaItems.join(" • ")}</div>` : "";

  const titleSlide = [
    `<section class="slide slide-title-slide active" data-slide-index="0" aria-label="Title slide">`,
    `  <div class="slide-content">`,
    `    <h1 class="slide-main-title">${safeTitle}</h1>`,
    subtitleHtml.length > 0 ? `    ${subtitleHtml}` : "",
    metaHtml.length > 0 ? `    ${metaHtml}` : "",
    `  </div>`,
    `  <div class="slide-hint">Use ArrowLeft / ArrowRight to navigate</div>`,
    `</section>`
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  const sectionSlides = request.sections
    .map((section, idx) => {
      const slideNumber = idx + 1;
      const headingHtml = `<h2 class="slide-heading">${escapeHtml(section.heading)}</h2>`;
      const calloutHtml = section.callout ? renderCalloutHtml(section.callout) : "";
      const contentHtml = parseMarkdownToHtml(section.content);
      const subheadingsHtml = renderSubheadingsHtml(section.subheadings);

      return [
        `<section class="slide slide-section-slide" data-slide-index="${slideNumber}" aria-label="Slide ${slideNumber}: ${escapeHtml(
          section.heading
        )}">`,
        `  <header class="slide-header">${headingHtml}</header>`,
        `  <div class="slide-body">`,
        calloutHtml.length > 0 ? `    ${calloutHtml}` : "",
        `    <div class="slide-markdown">${contentHtml}</div>`,
        subheadingsHtml.length > 0 ? `    ${subheadingsHtml}` : "",
        `  </div>`,
        `  <footer class="slide-footer">`,
        `    <span class="slide-footer-doc-title">${safeTitle}</span>`,
        `  </footer>`,
        `</section>`
      ]
        .filter((line) => line.length > 0)
        .join("\n");
    })
    .join("\n\n");

  const totalSlides = request.sections.length + 1;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle} - Slides</title>
  <style>
${getSlideDeckCss(theme)}
  </style>
</head>
<body class="theme-${theme}">
  <div class="deck-wrapper">
    <div class="deck-progress-track">
      <div class="deck-progress-bar" id="slide-progress" style="width: 0%;"></div>
    </div>
    <div class="deck-stage" id="deck-stage">
      ${titleSlide}
      ${sectionSlides}
    </div>
    <div class="deck-controls">
      <button class="deck-btn" id="btn-prev" aria-label="Previous slide">&larr;</button>
      <div class="deck-counter" aria-live="polite">
        <span id="slide-current">1</span> / <span id="slide-total">${totalSlides}</span>
      </div>
      <button class="deck-btn" id="btn-next" aria-label="Next slide">&rarr;</button>
      <button class="deck-btn deck-btn-theme" id="btn-theme" aria-label="Toggle dark and light theme">Theme</button>
    </div>
  </div>
  <script>
${getSlideDeckScript()}
  </script>
</body>
</html>`;
}

function escapeTypstString(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeTypstText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/#/g, "\\#")
    .replace(/\$/g, "\\$");
}

function formatInlineTypst(text: string): string {
  const codeSnippets: string[] = [];
  let tokenized = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSnippets.push(code);
    return `__CODE_TOKEN_${codeSnippets.length - 1}__`;
  });

  tokenized = escapeTypstText(tokenized);
  tokenized = tokenized.replace(/\*\*([^*]+)\*\*/g, "*$1*");
  tokenized = tokenized.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, "$1_$2_$3");

  tokenized = tokenized.replace(/\\\[([^\]]+)\\\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
    return `#link("${escapeTypstString(url)}")[${label}]`;
  });

  tokenized = tokenized.replace(/__CODE_TOKEN_(\d+)__/g, (_match, idxStr: string) => {
    const idx = parseInt(idxStr, 10);
    const snippet = codeSnippets[idx];
    return snippet !== undefined ? `\`${snippet}\`` : "";
  });

  return tokenized;
}

function convertMarkdownToTypst(markdown: string): string {
  const trimmed = markdown.trim();
  if (trimmed.length === 0) return "";

  const lines = markdown.split(/\r?\n/);
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const currentLine = lines[i];
    if (currentLine === undefined) {
      i++;
      continue;
    }

    const trimmedLine = currentLine.trim();
    if (trimmedLine.length === 0) {
      i++;
      continue;
    }

    if (trimmedLine.startsWith("```")) {
      const lang = trimmedLine.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const cLine = lines[i];
        if (cLine === undefined) {
          i++;
          continue;
        }
        if (cLine.trim().startsWith("```")) {
          i++;
          break;
        }
        codeLines.push(cLine);
        i++;
      }
      blocks.push("```" + lang + "\n" + codeLines.join("\n") + "\n```");
      continue;
    }

    if (/^(?:---|\*\*\*|___)\s*$/.test(trimmedLine)) {
      blocks.push('#line(length: 100%, stroke: 0.5pt + rgb("#e4e4e7"))');
      i++;
      continue;
    }

    const headingMatch = trimmedLine.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const hashes = headingMatch[1];
      const text = headingMatch[2];
      if (hashes !== undefined && text !== undefined) {
        const typstLevel = "=".repeat(hashes.length + 1);
        blocks.push(`${typstLevel} ${escapeTypstText(text)}`);
        i++;
        continue;
      }
    }

    if (trimmedLine.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const qLine = lines[i];
        if (qLine === undefined) break;
        const qTrim = qLine.trim();
        if (qTrim.startsWith(">")) {
          quoteLines.push(qTrim.replace(/^>\s?/, ""));
          i++;
        } else if (qTrim.length === 0) {
          break;
        } else {
          quoteLines.push(qTrim);
          i++;
        }
      }
      const quoteContent = quoteLines.map((l) => formatInlineTypst(l)).join("\n");
      blocks.push(
        `#rect(width: 100%, stroke: (left: 2.5pt + rgb("#a1a1aa")), inset: (left: 10pt, top: 4pt, bottom: 4pt))[${quoteContent}]`
      );
      continue;
    }

    if (trimmedLine.includes("|") && i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      if (nextLine !== undefined && /^\s*\|?\s*:?-+:?\s*\|/.test(nextLine)) {
        const headerRow = trimmedLine;
        i += 2;
        const bodyRows: string[] = [];
        while (i < lines.length) {
          const tLine = lines[i];
          if (tLine === undefined) break;
          const tTrim = tLine.trim();
          if (!tTrim.includes("|") || tTrim.length === 0) break;
          bodyRows.push(tTrim);
          i++;
        }
        const splitRow = (row: string): string[] => {
          let r = row.trim();
          if (r.startsWith("|")) r = r.slice(1);
          if (r.endsWith("|")) r = r.slice(0, -1);
          return r.split("|").map((c) => c.trim());
        };
        const headers = splitRow(headerRow);
        const columnsSpec = `(${headers.map(() => "1fr").join(", ")})`;
        const headerCells = headers.map((h) => `[*${formatInlineTypst(h)}*]`).join(", ");
        const bodyCells = bodyRows
          .flatMap((row) => splitRow(row).map((c) => `[${formatInlineTypst(c)}]`))
          .join(",\n  ");

        blocks.push(
          `#table(\n  columns: ${columnsSpec},\n  stroke: 0.5pt + rgb("#e4e4e7"),\n  fill: (col, row) => if row == 0 { rgb("#f4f4f5") } else { none },\n  ${headerCells}${bodyCells.length > 0 ? ",\n  " + bodyCells : ""}\n)`
        );
        continue;
      }
    }

    if (/^[-*]\s+/.test(trimmedLine)) {
      const items: string[] = [];
      while (i < lines.length) {
        const uLine = lines[i];
        if (uLine === undefined) break;
        const uTrim = uLine.trim();
        const itemMatch = uTrim.match(/^[-*]\s+(.*)$/);
        if (itemMatch) {
          const it = itemMatch[1];
          if (it !== undefined) {
            items.push(`- ${formatInlineTypst(it)}`);
          }
          i++;
        } else if (uTrim.length === 0) {
          break;
        } else {
          if (items.length > 0) {
            const lastIdx = items.length - 1;
            items[lastIdx] = `${items[lastIdx]!} ${formatInlineTypst(uTrim)}`;
          }
          i++;
        }
      }
      blocks.push(items.join("\n"));
      continue;
    }

    if (/^\d+\.\s+/.test(trimmedLine)) {
      const items: string[] = [];
      while (i < lines.length) {
        const oLine = lines[i];
        if (oLine === undefined) break;
        const oTrim = oLine.trim();
        const itemMatch = oTrim.match(/^\d+\.\s+(.*)$/);
        if (itemMatch) {
          const it = itemMatch[1];
          if (it !== undefined) {
            items.push(`+ ${formatInlineTypst(it)}`);
          }
          i++;
        } else if (oTrim.length === 0) {
          break;
        } else {
          if (items.length > 0) {
            const lastIdx = items.length - 1;
            items[lastIdx] = `${items[lastIdx]!} ${formatInlineTypst(oTrim)}`;
          }
          i++;
        }
      }
      blocks.push(items.join("\n"));
      continue;
    }

    const pLines: string[] = [];
    while (i < lines.length) {
      const pLine = lines[i];
      if (pLine === undefined) break;
      const pTrim = pLine.trim();
      if (pTrim.length === 0) {
        i++;
        break;
      }
      if (
        pTrim.startsWith("```") ||
        pTrim.startsWith(">") ||
        /^(?:---|\*\*\*|___)\s*$/.test(pTrim) ||
        /^#{1,6}\s+/.test(pTrim) ||
        /^[-*]\s+/.test(pTrim) ||
        /^\d+\.\s+/.test(pTrim) ||
        (pTrim.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*\|/.test(lines[i + 1] ?? ""))
      ) {
        break;
      }
      pLines.push(pTrim);
      i++;
    }
    if (pLines.length > 0) {
      blocks.push(pLines.map((l) => formatInlineTypst(l)).join(" "));
    }
  }

  return blocks.join("\n\n");
}

export function generateTypstSource(request: PublicationRequest): string {
  const theme = request.theme ?? "graphite";
  const safeTitle = escapeTypstText(request.title || "Document");

  const fontList =
    theme === "editorial"
      ? '("IBM Plex Serif", "Georgia", "PT Serif")'
      : '("IBM Plex Sans", "Helvetica Neue", "Arial")';
  const textFill = theme === "classic" ? '#0f172a' : theme === "editorial" ? '#262626' : '#18181b';
  const dividerStroke = theme === "editorial" ? '#e5e5e5' : '#e4e4e7';

  const metaItems: string[] = [];
  if (request.author && request.author.trim().length > 0) {
    metaItems.push(`Author: ${escapeTypstText(request.author.trim())}`);
  }
  if (request.date && request.date.trim().length > 0) {
    metaItems.push(`Date: ${escapeTypstText(request.date.trim())}`);
  }
  const metaTypst =
    metaItems.length > 0
      ? `\n  #v(0.6em)\n  #text(size: 9.5pt, fill: rgb("#71717a"))[${metaItems.join(" *•* ")}]`
      : "";

  const subtitleTypst =
    request.subtitle && request.subtitle.trim().length > 0
      ? `\n  #v(0.4em)\n  #text(size: 13pt, fill: rgb("#71717a"))[${escapeTypstText(request.subtitle.trim())}]`
      : "";

  const sectionsTypst = request.sections
    .map((section) => {
      const parts: string[] = [`= ${escapeTypstText(section.heading)}`];

      if (section.callout) {
        const cType = section.callout.type;
        const cBg = cType === "warning" ? "#fef2f2" : cType === "metric" ? "#f0fdf4" : "#f4f4f5";
        const cBorder = cType === "warning" ? "#ef4444" : cType === "metric" ? "#22c55e" : "#71717a";
        const cLabel = cType === "warning" ? "Warning" : cType === "metric" ? "Metric" : "Note";

        parts.push(
          `#rect(\n  width: 100%,\n  fill: rgb("${cBg}"),\n  stroke: (left: 3pt + rgb("${cBorder}")),\n  radius: (right: 4pt),\n  inset: 10pt\n)[\n  *${cLabel}:* ${formatInlineTypst(
            section.callout.text
          )}\n]`
        );
      }

      const body = convertMarkdownToTypst(section.content);
      if (body.length > 0) {
        parts.push(body);
      }

      if (section.subheadings && section.subheadings.length > 0) {
        for (const sub of section.subheadings) {
          parts.push(`== ${escapeTypstText(sub.title)}`);
          const subBody = convertMarkdownToTypst(sub.body);
          if (subBody.length > 0) {
            parts.push(subBody);
          }
        }
      }

      return parts.join("\n\n");
    })
    .join("\n\n");

  return `// Rellane Publication Engine - Typst Document
// Theme: ${theme}

#set page(
  paper: "a4",
  margin: (top: 2.5cm, bottom: 2.5cm, left: 2.5cm, right: 2.5cm),
  header: align(right)[
    #text(size: 8.5pt, fill: rgb("#71717a"))[${safeTitle}]
  ],
  numbering: "1"
)

#set text(
  font: ${fontList},
  size: 10.5pt,
  fill: rgb("${textFill}")
)

#set par(justify: true, leading: 0.7em)

#align(center)[
  #block(text(size: 22pt, weight: "bold")[${safeTitle}])${subtitleTypst}${metaTypst}
]

#v(1.2em)
#line(length: 100%, stroke: 0.5pt + rgb("${dividerStroke}"))
#v(1.2em)

${sectionsTypst}
`;
}

export function generateMarkdownReport(request: PublicationRequest): string {
  const frontmatter: string[] = ["---", `title: ${JSON.stringify(request.title)}`];
  if (request.subtitle && request.subtitle.trim().length > 0) {
    frontmatter.push(`subtitle: ${JSON.stringify(request.subtitle.trim())}`);
  }
  if (request.author && request.author.trim().length > 0) {
    frontmatter.push(`author: ${JSON.stringify(request.author.trim())}`);
  }
  if (request.date && request.date.trim().length > 0) {
    frontmatter.push(`date: ${JSON.stringify(request.date.trim())}`);
  }
  if (request.theme) {
    frontmatter.push(`theme: ${JSON.stringify(request.theme)}`);
  }
  frontmatter.push("---");

  const lines: string[] = [frontmatter.join("\n"), "", `# ${request.title}`];

  if (request.subtitle && request.subtitle.trim().length > 0) {
    lines.push("", `*${request.subtitle.trim()}*`);
  }

  const metaParts: string[] = [];
  if (request.author && request.author.trim().length > 0) {
    metaParts.push(`**Author:** ${request.author.trim()}`);
  }
  if (request.date && request.date.trim().length > 0) {
    metaParts.push(`**Date:** ${request.date.trim()}`);
  }
  if (metaParts.length > 0) {
    lines.push("", metaParts.join(" | "));
  }

  lines.push("", "---");

  for (let i = 0; i < request.sections.length; i++) {
    const section = request.sections[i]!;
    lines.push("", `## ${section.heading}`);

    if (section.callout) {
      const calloutText = section.callout.text.trim();
      if (section.callout.type === "note") {
        lines.push("", "> [!NOTE]", `> ${calloutText.replace(/\n/g, "\n> ")}`);
      } else if (section.callout.type === "warning") {
        lines.push("", "> [!WARNING]", `> ${calloutText.replace(/\n/g, "\n> ")}`);
      } else {
        lines.push("", "> [!IMPORTANT]", `> **Metric:** ${calloutText.replace(/\n/g, "\n> ")}`);
      }
    }

    if (section.content.trim().length > 0) {
      lines.push("", section.content.trim());
    }

    if (section.subheadings && section.subheadings.length > 0) {
      for (const sub of section.subheadings) {
        lines.push("", `### ${sub.title}`, "", sub.body.trim());
      }
    }

    if (i < request.sections.length - 1) {
      lines.push("", "---");
    }
  }

  lines.push("");
  return lines.join("\n");
}

function slugify(title: string): string {
  const clean = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean.length > 0 ? clean : "document";
}

function resolveFilename(title: string, format: PublicationFormat): string {
  const slug = slugify(title);
  switch (format) {
    case "slides":
      return `${slug}-slides.html`;
    case "typst":
      return `${slug}.typ`;
    case "markdown":
      return `${slug}.md`;
    case "html":
    default:
      return `${slug}.html`;
  }
}

function resolveMimeType(format: PublicationFormat): string {
  switch (format) {
    case "typst":
      return "text/x-typst";
    case "markdown":
      return "text/markdown";
    case "html":
    case "slides":
    default:
      return "text/html";
  }
}

function estimatePageCount(request: PublicationRequest): number {
  if (request.format === "slides") {
    return Math.max(1, request.sections.length + 1);
  }
  let totalChars = request.title.length + (request.subtitle?.length ?? 0);
  for (let i = 0; i < request.sections.length; i++) {
    const section = request.sections[i]!;
    totalChars += section.heading.length + 200;
    totalChars += section.content.length;
    if (section.callout) {
      totalChars += section.callout.text.length + 100;
    }
    if (section.subheadings) {
      for (let j = 0; j < section.subheadings.length; j++) {
        const sub = section.subheadings[j]!;
        totalChars += sub.title.length + sub.body.length + 100;
      }
    }
  }
  return Math.max(1, Math.ceil(totalChars / 2000));
}

export function publishDocument(request: PublicationRequest): PublicationResult {
  const format = request.format;
  let content: string;

  switch (format) {
    case "slides":
      content = generateSlideDeckHtml(request);
      break;
    case "typst":
      content = generateTypstSource(request);
      break;
    case "markdown":
      content = generateMarkdownReport(request);
      break;
    case "html":
    default:
      content = generateHtmlDocument(request);
      break;
  }

  const filename = resolveFilename(request.title, format);
  const mimeType = resolveMimeType(format);
  const pageCountEstimate = estimatePageCount(request);

  return {
    format,
    filename,
    mimeType,
    content,
    pageCountEstimate
  };
}
