export type PublishFormat = "html" | "markdown" | "slides";

export interface PublishInput {
  readonly title: string;
  readonly body: string;
  readonly format: PublishFormat;
  readonly author: string;
  readonly at: number;
  readonly sources: readonly { readonly label: string }[];
}

export interface PublishFile {
  readonly relativePath: string;
  readonly contents: string;
}

export interface PublishResult {
  readonly files: readonly PublishFile[];
  readonly summary: string;
  readonly warnings: readonly string[];
}

const MAX_BODY_CHARACTERS = 500_000;
const EMPTY_BODY_NOTICE = "This output is empty.";

function sanitizeFilename(title: string, fallback: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : fallback;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isSafeUrl(url: string): boolean {
  // Disallow javascript, data, and vbscript schemes to prevent script execution on click
  const cleaned = url.replace(/[\x00-\x20\x7f-\x9f\s]/g, "").toLowerCase();
  const stripped = cleaned.replace(/&#[xX]?[0-9a-fA-F]+;/g, "");
  if (
    stripped.startsWith("javascript:") ||
    stripped.startsWith("data:") ||
    stripped.startsWith("vbscript:")
  ) {
    return false;
  }
  return true;
}

function formatEmphasis(text: string): string {
  return text
    .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/___([^_]+)___/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1<em>$2</em>");
}

function parseInline(rawText: string, warnings: string[]): string {
  const codeTokens: string[] = [];
  const textWithCodeTokens = rawText.replace(/`([^`]+)`/g, (_match, code: string) => {
    const token = `\x00CODE_${codeTokens.length}\x00`;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  const linkTokens: string[] = [];
  const textWithLinks = textWithCodeTokens.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, linkText: string, url: string) => {
      const trimmedUrl = url.trim();
      if (!isSafeUrl(trimmedUrl)) {
        // Neutralise unsafe links into plain text rather than dropping reader context
        warnings.push(`Blocked unsafe link target: "${trimmedUrl}".`);
        const token = `\x00LINK_${linkTokens.length}\x00`;
        linkTokens.push(escapeHtml(linkText));
        return token;
      }
      const token = `\x00LINK_${linkTokens.length}\x00`;
      const escapedUrl = escapeHtml(trimmedUrl);
      const formattedLinkText = formatEmphasis(escapeHtml(linkText));
      linkTokens.push(`<a href="${escapedUrl}" rel="noopener noreferrer">${formattedLinkText}</a>`);
      return token;
    }
  );

  const escapedText = escapeHtml(textWithLinks);
  const formattedText = formatEmphasis(escapedText);

  let result = formattedText;
  for (let i = 0; i < linkTokens.length; i++) {
    const token = `\x00LINK_${i}\x00`;
    result = result.split(token).join(linkTokens[i]!);
  }
  for (let i = 0; i < codeTokens.length; i++) {
    const token = `\x00CODE_${i}\x00`;
    result = result.split(token).join(codeTokens[i]!);
  }

  return result;
}

function renderMarkdownToHtml(markdown: string, warnings: string[]): string {
  const lines = markdown.split("\n");
  const htmlBlocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    const fenceMatch = line.match(/^(```|~~~)(.*)$/);
    if (fenceMatch) {
      const fence = fenceMatch[1]!;
      const rawLanguage = fenceMatch[2]!.trim();
      const language = rawLanguage.length > 0 ? rawLanguage.split(/\s+/)[0]! : "";
      const codeLines: string[] = [];
      i++;
      let closed = false;

      while (i < lines.length) {
        const codeLine = lines[i]!;
        if (codeLine.startsWith(fence)) {
          closed = true;
          i++;
          break;
        }
        codeLines.push(codeLine);
        i++;
      }

      if (!closed) {
        // Close unclosed code fences at EOF so document markup remains valid
        warnings.push("An unclosed code block was automatically closed at the end of the document.");
      }

      const escapedCode = escapeHtml(codeLines.join("\n"));
      const classAttr = language.length > 0 ? ` class="language-${escapeHtml(language)}"` : "";
      htmlBlocks.push(`<pre><code${classAttr}>${escapedCode}</code></pre>`);
      continue;
    }

    if (line.trim().length === 0) {
      i++;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!.trim();
      htmlBlocks.push(`<h${level}>${parseInline(text, warnings)}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      htmlBlocks.push("<hr />");
      i++;
      continue;
    }

    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) {
        quoteLines.push(lines[i]!.replace(/^>\s?/, ""));
        i++;
      }
      const quoteText = quoteLines.join(" ").trim();
      htmlBlocks.push(`<blockquote><p>${parseInline(quoteText, warnings)}</p></blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const itemLine = lines[i]!;
        const itemMatch = itemLine.match(/^\s*[-*+]\s+(.+)$/);
        if (itemMatch) {
          items.push(itemMatch[1]!.trim());
          i++;
        } else if (/^\s{2,}\S/.test(itemLine) && items.length > 0) {
          items[items.length - 1] += " " + itemLine.trim();
          i++;
        } else {
          break;
        }
      }
      const listItemsHtml = items
        .map(item => `  <li>${parseInline(item, warnings)}</li>`)
        .join("\n");
      htmlBlocks.push(`<ul>\n${listItemsHtml}\n</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const itemLine = lines[i]!;
        const itemMatch = itemLine.match(/^\s*\d+\.\s+(.+)$/);
        if (itemMatch) {
          items.push(itemMatch[1]!.trim());
          i++;
        } else if (/^\s{2,}\S/.test(itemLine) && items.length > 0) {
          items[items.length - 1] += " " + itemLine.trim();
          i++;
        } else {
          break;
        }
      }
      const listItemsHtml = items
        .map(item => `  <li>${parseInline(item, warnings)}</li>`)
        .join("\n");
      htmlBlocks.push(`<ol>\n${listItemsHtml}\n</ol>`);
      continue;
    }

    const paragraphLines: string[] = [];
    while (i < lines.length) {
      const pLine = lines[i]!;
      if (pLine.trim().length === 0) {
        break;
      }
      if (
        pLine.startsWith("#") ||
        pLine.startsWith(">") ||
        /^(```|~~~)/.test(pLine) ||
        /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(pLine) ||
        /^\s*[-*+]\s+/.test(pLine) ||
        /^\s*\d+\.\s+/.test(pLine)
      ) {
        break;
      }
      paragraphLines.push(pLine.trim());
      i++;
    }

    if (paragraphLines.length > 0) {
      const paragraphText = paragraphLines.join(" ");
      htmlBlocks.push(`<p>${parseInline(paragraphText, warnings)}</p>`);
    }
  }

  return htmlBlocks.join("\n\n");
}

function findTopLevelHeadingPrefix(lines: readonly string[]): string | null {
  let inCodeFence = false;
  let fence = "";
  let highestLevel = 7;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = line.match(/^(```|~~~)/);
    if (fenceMatch) {
      if (!inCodeFence) {
        inCodeFence = true;
        fence = fenceMatch[1]!;
      } else if (line.startsWith(fence)) {
        inCodeFence = false;
      }
      continue;
    }
    if (inCodeFence) continue;

    const headingMatch = line.match(/^(#{1,6})\s+\S/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      if (level < highestLevel) {
        highestLevel = level;
      }
    }
  }

  if (highestLevel >= 1 && highestLevel <= 6) {
    return "#".repeat(highestLevel);
  }
  return null;
}

function splitIntoSlides(body: string): readonly string[] {
  const lines = body.split("\n");
  const prefix = findTopLevelHeadingPrefix(lines);
  if (prefix === null) {
    // Single slide fallback for documents lacking top-level headings
    return [body.trim()];
  }

  const headingRegex = new RegExp(`^${prefix}\\s+\\S`);
  const slides: string[] = [];
  let currentSlideLines: string[] = [];
  let inCodeFence = false;
  let fence = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = line.match(/^(```|~~~)/);
    if (fenceMatch) {
      if (!inCodeFence) {
        inCodeFence = true;
        fence = fenceMatch[1]!;
      } else if (line.startsWith(fence)) {
        inCodeFence = false;
      }
      currentSlideLines.push(line);
      continue;
    }

    if (!inCodeFence && headingRegex.test(line)) {
      if (currentSlideLines.length > 0) {
        const text = currentSlideLines.join("\n").trim();
        if (text.length > 0) {
          slides.push(text);
        }
      }
      currentSlideLines = [line];
    } else {
      currentSlideLines.push(line);
    }
  }

  if (currentSlideLines.length > 0) {
    const text = currentSlideLines.join("\n").trim();
    if (text.length > 0) {
      slides.push(text);
    }
  }

  return slides.length > 0 ? slides : [body.trim()];
}

export function publishOutput(input: PublishInput): PublishResult {
  const warnings: string[] = [];

  let normalizedBody = input.body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Prevent memory exhaustion on unbounded inputs by capping at 500k characters
  if (normalizedBody.length > MAX_BODY_CHARACTERS) {
    const cutCount = normalizedBody.length - MAX_BODY_CHARACTERS;
    normalizedBody = normalizedBody.slice(0, MAX_BODY_CHARACTERS);
    warnings.push(
      `The document body was capped at 500,000 characters; cut ${cutCount.toLocaleString("en-GB")} characters from the end.`
    );
  }

  const isBodyEmpty = normalizedBody.trim().length === 0;
  if (isBodyEmpty) {
    warnings.push("The document body is empty.");
    normalizedBody = EMPTY_BODY_NOTICE;
  }

  const validSources = input.sources
    .map(s => ({ label: s.label.trim() }))
    .filter(s => s.label.length > 0);

  const cleanTitle = input.title.trim();

  if (input.format === "markdown") {
    const filename = `${sanitizeFilename(cleanTitle, "output")}.md`;

    let mdContent = normalizedBody;
    const hasTitleHeading = /^#\s+\S/.test(mdContent.trimStart());
    if (!hasTitleHeading && cleanTitle.length > 0) {
      mdContent = `# ${cleanTitle}\n\n${mdContent}`;
    }

    if (validSources.length > 0) {
      const sourceList = validSources.map(s => `- ${s.label}`).join("\n");
      mdContent = `${mdContent.trimEnd()}\n\n## Sources\n\n${sourceList}\n`;
    } else if (!mdContent.endsWith("\n")) {
      mdContent += "\n";
    }

    return {
      files: [{ relativePath: filename, contents: mdContent }],
      summary: "A Markdown document ready to share.",
      warnings,
    };
  }

  if (input.format === "html") {
    const filename = `${sanitizeFilename(cleanTitle, "document")}.html`;

    let bodyToRender = normalizedBody;
    const hasTitleHeading = /^#\s+\S/.test(bodyToRender.trimStart());
    if (!hasTitleHeading && cleanTitle.length > 0) {
      bodyToRender = `# ${cleanTitle}\n\n${bodyToRender}`;
    }

    let renderedHtml = renderMarkdownToHtml(bodyToRender, warnings);

    const metaParts: string[] = [];
    if (input.author.trim().length > 0) {
      metaParts.push(`By ${escapeHtml(input.author.trim())}`);
    }
    if (input.at > 0) {
      const dateStr = new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(new Date(input.at));
      metaParts.push(escapeHtml(dateStr));
    }

    if (metaParts.length > 0) {
      const bylineHtml = `<div class="document-byline">${metaParts.join(" &bull; ")}</div>`;
      if (renderedHtml.includes("</h1>")) {
        const h1End = renderedHtml.indexOf("</h1>") + 5;
        renderedHtml = renderedHtml.slice(0, h1End) + "\n" + bylineHtml + renderedHtml.slice(h1End);
      } else {
        renderedHtml = `${bylineHtml}\n\n${renderedHtml}`;
      }
    }

    if (validSources.length > 0) {
      const sourcesListHtml = validSources
        .map(s => `    <li>${escapeHtml(s.label)}</li>`)
        .join("\n");
      const sourcesHtml = `<section class="sources-section">\n  <h2>Sources</h2>\n  <ul>\n${sourcesListHtml}\n  </ul>\n</section>`;
      renderedHtml = `${renderedHtml}\n\n${sourcesHtml}`;
    }

    const docTitle = cleanTitle.length > 0 ? escapeHtml(cleanTitle) : "Document";
    const fullHtml = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>${docTitle}</title>\n<style>\n:root {\n  color-scheme: light dark;\n  --ws-ground: #f8f9fa;\n  --ws-paper: #ffffff;\n  --ws-ink: #1e2022;\n  --ws-muted: #61666d;\n  --ws-line: #e2e4e8;\n  --ws-code-bg: #f1f3f5;\n  --ws-quote-border: #3b82f6;\n  --ws-link: #2563eb;\n}\n\n@media (prefers-color-scheme: dark) {\n  :root {\n    --ws-ground: #0f1115;\n    --ws-paper: #181a1f;\n    --ws-ink: #e6e8ec;\n    --ws-muted: #8b929e;\n    --ws-line: #2a2e37;\n    --ws-code-bg: #21252e;\n    --ws-quote-border: #60a5fa;\n    --ws-link: #60a5fa;\n  }\n}\n\n*, *::before, *::after {\n  box-sizing: border-box;\n}\n\nbody {\n  margin: 0;\n  padding: 3rem 1.5rem;\n  background-color: var(--ws-ground);\n  color: var(--ws-ink);\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;\n  font-size: 1.0625rem;\n  line-height: 1.65;\n  text-rendering: optimizeLegibility;\n  -webkit-font-smoothing: antialiased;\n}\n\n.document-container {\n  max-width: 68ch;\n  margin: 0 auto;\n  background-color: var(--ws-paper);\n  padding: 3.5rem 3rem;\n  border-radius: 8px;\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);\n  border: 1px solid var(--ws-line);\n}\n\n@media (max-width: 640px) {\n  body {\n    padding: 1rem 0.5rem;\n  }\n  .document-container {\n    padding: 1.5rem 1.25rem;\n    border-radius: 0;\n    border: none;\n    box-shadow: none;\n  }\n}\n\nh1, h2, h3, h4, h5, h6 {\n  color: var(--ws-ink);\n  line-height: 1.25;\n  margin-top: 2rem;\n  margin-bottom: 0.75rem;\n  font-weight: 600;\n}\n\nh1:first-child {\n  margin-top: 0;\n}\n\nh1 { font-size: 2.125rem; }\nh2 { font-size: 1.5rem; margin-top: 2.25rem; border-bottom: 1px solid var(--ws-line); padding-bottom: 0.35rem; }\nh3 { font-size: 1.25rem; }\nh4 { font-size: 1.1rem; }\nh5, h6 { font-size: 1rem; }\n\np {\n  margin: 0 0 1.25rem 0;\n}\n\na {\n  color: var(--ws-link);\n  text-decoration: underline;\n  text-underline-offset: 2px;\n}\n\ncode {\n  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;\n  font-size: 0.9em;\n  background-color: var(--ws-code-bg);\n  padding: 0.15em 0.35em;\n  border-radius: 4px;\n}\n\npre {\n  background-color: var(--ws-code-bg);\n  padding: 1.125rem;\n  border-radius: 6px;\n  overflow-x: auto;\n  margin: 1.5rem 0;\n  border: 1px solid var(--ws-line);\n}\n\npre code {\n  background: transparent;\n  padding: 0;\n  font-size: 0.875rem;\n  line-height: 1.5;\n  display: block;\n}\n\nblockquote {\n  margin: 1.5rem 0;\n  padding: 0.5rem 0 0.5rem 1.25rem;\n  border-left: 4px solid var(--ws-quote-border);\n  color: var(--ws-muted);\n}\n\nblockquote p:last-child {\n  margin-bottom: 0;\n}\n\nul, ol {\n  margin: 0 0 1.25rem 0;\n  padding-left: 1.75rem;\n}\n\nli {\n  margin-bottom: 0.35rem;\n}\n\nhr {\n  border: 0;\n  height: 1px;\n  background-color: var(--ws-line);\n  margin: 2.5rem 0;\n}\n\n.document-byline {\n  font-size: 0.9375rem;\n  color: var(--ws-muted);\n  margin-top: -0.25rem;\n  margin-bottom: 2rem;\n  padding-bottom: 1rem;\n  border-bottom: 1px solid var(--ws-line);\n}\n\n.sources-section {\n  margin-top: 3rem;\n  padding-top: 1.5rem;\n  border-top: 1px solid var(--ws-line);\n}\n\n.sources-section h2 {\n  font-size: 1.125rem;\n  margin-top: 0;\n  border-bottom: none;\n  padding-bottom: 0;\n}\n\n.sources-section ul {\n  font-size: 0.9375rem;\n  color: var(--ws-muted);\n}\n\n@media print {\n  body {\n    background: #ffffff !important;\n    color: #000000 !important;\n    padding: 0 !important;\n    font-size: 11pt;\n    line-height: 1.5;\n  }\n  .document-container {\n    max-width: 100% !important;\n    margin: 0 !important;\n    padding: 0 !important;\n    border: none !important;\n    box-shadow: none !important;\n    background: transparent !important;\n  }\n  a {\n    color: #000000 !important;\n    text-decoration: underline;\n  }\n  pre, blockquote {\n    page-break-inside: avoid;\n    break-inside: avoid;\n  }\n  h1, h2, h3 {\n    page-break-after: avoid;\n    break-after: avoid;\n  }\n}\n</style>\n</head>\n<body>\n<div class="document-container">\n${renderedHtml}\n</div>\n</body>\n</html>\n`;

    return {
      files: [{ relativePath: filename, contents: fullHtml }],
      summary: "A standalone web page ready to view or print.",
      warnings,
    };
  }

  const filename = `${sanitizeFilename(cleanTitle, "slides")}.html`;
  const rawSlides = splitIntoSlides(normalizedBody);
  const totalSlidesCount = rawSlides.length + (validSources.length > 0 ? 1 : 0);
  const slideElements: string[] = [];

  for (let idx = 0; idx < rawSlides.length; idx++) {
    const slideText = rawSlides[idx]!;
    const slideHtml = renderMarkdownToHtml(slideText, warnings);
    const activeClass = idx === 0 ? " active" : "";
    slideElements.push(
      `<section class="slide${activeClass}" id="slide-${idx + 1}" aria-label="Slide ${idx + 1} of ${totalSlidesCount}">\n  <div class="slide-content">\n${slideHtml}\n  </div>\n</section>`
    );
  }

  if (validSources.length > 0) {
    const sourcesListHtml = validSources
      .map(s => `      <li>${escapeHtml(s.label)}</li>`)
      .join("\n");
    const sourcesSlideIndex = slideElements.length + 1;
    const activeClass = slideElements.length === 0 ? " active" : "";
    slideElements.push(
      `<section class="slide${activeClass}" id="slide-${sourcesSlideIndex}" aria-label="Slide ${sourcesSlideIndex} of ${totalSlidesCount}">\n  <div class="slide-content">\n    <h2>Sources</h2>\n    <ul>\n${sourcesListHtml}\n    </ul>\n  </div>\n</section>`
    );
  }

  const slidesCount = slideElements.length;
  const deckTitle = cleanTitle.length > 0 ? escapeHtml(cleanTitle) : "Presentation";
  const slidesHtml = slideElements.join("\n");

  const fullSlidesHtml = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>${deckTitle}</title>\n<style>\n:root {\n  color-scheme: light dark;\n  --ws-ground: #ffffff;\n  --ws-ink: #111827;\n  --ws-muted: #6b7280;\n  --ws-line: #e5e7eb;\n  --ws-code-bg: #f3f4f6;\n  --ws-link: #2563eb;\n}\n\n@media (prefers-color-scheme: dark) {\n  :root {\n    --ws-ground: #0b0f17;\n    --ws-ink: #f9fafb;\n    --ws-muted: #9ca3af;\n    --ws-line: #1f2937;\n    --ws-code-bg: #1f2937;\n    --ws-link: #60a5fa;\n  }\n}\n\n*, *::before, *::after {\n  box-sizing: border-box;\n}\n\nhtml, body {\n  margin: 0;\n  padding: 0;\n  width: 100%;\n  height: 100%;\n  overflow: hidden;\n  background-color: var(--ws-ground);\n  color: var(--ws-ink);\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;\n  font-size: clamp(20px, 2.2vw, 32px);\n  line-height: 1.5;\n  -webkit-font-smoothing: antialiased;\n}\n\n.deck-container {\n  width: 100vw;\n  height: 100vh;\n  position: relative;\n  overflow: hidden;\n}\n\n.slide {\n  display: none;\n  position: absolute;\n  top: 0;\n  left: 0;\n  width: 100vw;\n  height: 100vh;\n  padding: 8vh 10vw;\n  flex-direction: column;\n  justify-content: center;\n  align-items: flex-start;\n  box-sizing: border-box;\n  overflow-y: auto;\n}\n\n.slide.active {\n  display: flex;\n}\n\n.slide-content {\n  width: 100%;\n  max-width: 1200px;\n  margin: 0 auto;\n}\n\nh1 {\n  font-size: 2.5em;\n  line-height: 1.15;\n  margin: 0 0 0.75em 0;\n  font-weight: 700;\n  letter-spacing: -0.02em;\n}\n\nh2 {\n  font-size: 1.8em;\n  line-height: 1.2;\n  margin: 0 0 0.6em 0;\n  font-weight: 600;\n}\n\nh3 {\n  font-size: 1.4em;\n  margin: 0 0 0.5em 0;\n}\n\np {\n  margin: 0 0 0.8em 0;\n}\n\nul, ol {\n  margin: 0 0 1em 0;\n  padding-left: 1.5em;\n}\n\nli {\n  margin-bottom: 0.4em;\n}\n\ncode {\n  font-family: ui-monospace, "SF Mono", Menlo, monospace;\n  font-size: 0.85em;\n  background-color: var(--ws-code-bg);\n  padding: 0.1em 0.3em;\n  border-radius: 4px;\n}\n\npre {\n  background-color: var(--ws-code-bg);\n  padding: 1em;\n  border-radius: 8px;\n  overflow-x: auto;\n  font-size: 0.75em;\n  line-height: 1.4;\n  margin: 0.8em 0;\n  max-width: 100%;\n}\n\npre code {\n  background: transparent;\n  padding: 0;\n}\n\nblockquote {\n  margin: 0.8em 0;\n  padding-left: 1em;\n  border-left: 6px solid var(--ws-muted);\n  color: var(--ws-muted);\n}\n\n.slide-counter {\n  position: fixed;\n  bottom: 2rem;\n  right: 2.5rem;\n  font-size: 0.75em;\n  font-variant-numeric: tabular-nums;\n  color: var(--ws-muted);\n  user-select: none;\n  z-index: 100;\n}\n\n.slide-nav {\n  position: fixed;\n  bottom: 2rem;\n  left: 2.5rem;\n  display: flex;\n  gap: 0.5rem;\n  z-index: 100;\n}\n\n.slide-nav-button {\n  background: transparent;\n  border: 1px solid var(--ws-line);\n  color: var(--ws-muted);\n  font-size: 0.7em;\n  padding: 0.3em 0.8em;\n  border-radius: 4px;\n  cursor: pointer;\n  font-family: inherit;\n}\n\n.slide-nav-button:hover {\n  color: var(--ws-ink);\n  border-color: var(--ws-muted);\n}\n\n@media print {\n  html, body, .deck-container {\n    height: auto !important;\n    overflow: visible !important;\n    font-size: 16pt !important;\n  }\n  .slide {\n    display: flex !important;\n    position: relative !important;\n    width: 100% !important;\n    height: 100vh !important;\n    page-break-after: always;\n    break-after: page;\n    padding: 2rem !important;\n  }\n  .slide-counter, .slide-nav {\n    display: none !important;\n  }\n}\n</style>\n</head>\n<body>\n<div class="deck-container">\n${slidesHtml}\n</div>\n<div class="slide-counter" id="slide-counter" aria-live="polite">1 / ${slidesCount}</div>\n<nav class="slide-nav" aria-label="Slide controls">\n  <button type="button" class="slide-nav-button" id="prev-btn" aria-label="Previous slide">&larr; Previous</button>\n  <button type="button" class="slide-nav-button" id="next-btn" aria-label="Next slide">Next &rarr;</button>\n</nav>\n<script>\n(function() {\n  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));\n  var counter = document.getElementById('slide-counter');\n  var prevBtn = document.getElementById('prev-btn');\n  var nextBtn = document.getElementById('next-btn');\n  var current = 0;\n  var total = slides.length;\n\n  function updateSlide(targetIndex) {\n    if (total === 0) return;\n    if (targetIndex < 0) targetIndex = 0;\n    if (targetIndex >= total) targetIndex = total - 1;\n    current = targetIndex;\n    for (var i = 0; i < total; i++) {\n      if (i === current) {\n        slides[i].classList.add('active');\n      } else {\n        slides[i].classList.remove('active');\n      }\n    }\n    if (counter) {\n      counter.textContent = (current + 1) + ' / ' + total;\n    }\n  }\n\n  window.addEventListener('keydown', function(event) {\n    if (event.defaultPrevented) return;\n    switch (event.key) {\n      case 'ArrowRight':\n      case 'ArrowDown':\n      case 'PageDown':\n      case ' ':\n        event.preventDefault();\n        updateSlide(current + 1);\n        break;\n      case 'ArrowLeft':\n      case 'ArrowUp':\n      case 'PageUp':\n        event.preventDefault();\n        updateSlide(current - 1);\n        break;\n      case 'Home':\n        event.preventDefault();\n        updateSlide(0);\n        break;\n      case 'End':\n        event.preventDefault();\n        updateSlide(total - 1);\n        break;\n    }\n  });\n\n  if (prevBtn) {\n    prevBtn.addEventListener('click', function() { updateSlide(current - 1); });\n  }\n  if (nextBtn) {\n    nextBtn.addEventListener('click', function() { updateSlide(current + 1); });\n  }\n\n  updateSlide(0);\n})();\n</script>\n</body>\n</html>\n`;

  return {
    files: [{ relativePath: filename, contents: fullSlidesHtml }],
    summary: "A slide presentation ready to view in your browser.",
    warnings,
  };
}
