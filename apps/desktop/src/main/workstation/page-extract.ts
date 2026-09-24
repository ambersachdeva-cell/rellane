export interface ExtractedPage {
  readonly title: string;
  readonly byline: string | null;
  readonly publishedAt: string | null;
  readonly text: string;
  readonly words: number;
  readonly links: readonly { readonly href: string; readonly text: string }[];
  readonly confidence: "high" | "low";
  readonly note: string;
}

interface Candidate {
  readonly tag: string;
  readonly html: string;
  readonly pTextLength: number;
  readonly totalTextLength: number;
  readonly linkTextLength: number;
  readonly linkDensity: number;
  readonly score: number;
}

const MAX_HTML_LENGTH = 2_000_000;
const CODE_PROTECT_START = "\uE000LT\uE001";

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"
]);

const STRIP_TAGS = new Set([
  "script", "style", "noscript", "svg", "iframe", "form",
  "nav", "header", "footer", "aside"
]);

const NEGATIVE_CLASS_OR_ID_KEYWORDS: readonly string[] = [
  "nav", "menu", "sidebar", "comment", "promo", "banner",
  "cookie", "consent", "subscribe", "share", "related", "footer", "advert"
];

const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "li", "pre", "tr", "div", "section"
]);

/**
 * Cells separate, they do not break. A row is one line, so a cell boundary puts
 * a space in rather than flushing a paragraph — without it "Quarterly Output"
 * and "£450,000" arrive as the single word "Output£450,000", which is a figure
 * nothing downstream can read.
 */
const CELL_TAGS = new Set(["td", "th"]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  pound: "£",
  euro: "€",
  yen: "¥",
  cent: "¢"
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:([a-zA-Z]+)|#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6}));?/g, (match, name, dec, hex) => {
    if (name) {
      const lower = name.toLowerCase();
      const entity = NAMED_ENTITIES[lower];
      if (entity !== undefined) {
        return entity;
      }
      return match;
    }
    if (dec) {
      const code = parseInt(dec, 10);
      if (code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    if (hex) {
      const code = parseInt(hex, 16);
      if (code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return match;
  });
}

function getAttribute(attrs: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = attrs.match(pattern);
  if (!match) {
    return null;
  }
  const val = match[1] ?? match[2] ?? match[3];
  return val !== undefined ? val : null;
}

function matchesNegativeClassOrId(attrs: string): boolean {
  const classVal = getAttribute(attrs, "class");
  const idVal = getAttribute(attrs, "id");
  const combined = `${classVal ?? ""} ${idVal ?? ""}`.toLowerCase();
  if (combined.trim() === "") {
    return false;
  }
  for (let i = 0; i < NEGATIVE_CLASS_OR_ID_KEYWORDS.length; i++) {
    const kw = NEGATIVE_CLASS_OR_ID_KEYWORDS[i]!;
    if (combined.includes(kw)) {
      return true;
    }
  }
  return false;
}

function protectCodeBlocks(html: string): string {
  // Protect markup characters inside code tags so code samples containing tags like </article>
  // are not mistakenly parsed as outer structural boundaries.
  return html.replace(/(<(pre|code)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi, (_match, open, _tag, content, close) => {
    const protectedContent = (content as string).replace(/</g, CODE_PROTECT_START);
    return `${open as string}${protectedContent}${close as string}`;
  });
}

function unprotectCode(text: string): string {
  return text.replaceAll(CODE_PROTECT_START, "<");
}

function stripUnwantedElements(rawHtml: string): string {
  // Strip comments first to prevent commented markup from confusing subsequent token matching
  const withoutComments = rawHtml.replace(/<!--[\s\S]*?-->/g, "");

  const tagPattern = /<(\/)?([a-zA-Z0-9:-]+)((?:\s+[^"'/>]*(?:(?:'[^']*'|"[^"]*")[^"'/>]*)*)?)\s*(\/?)>/g;

  let result = "";
  let lastIndex = 0;
  const stripStack: string[] = [];

  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(withoutComments)) !== null) {
    const fullTag = match[0]!;
    const isClosing = match[1] === "/";
    const tagName = match[2]!.toLowerCase();
    const attrs = match[3] ?? "";
    const isSelfClosing = match[4] === "/" || VOID_TAGS.has(tagName);
    const tagIndex = match.index;

    const textBetween = withoutComments.slice(lastIndex, tagIndex);
    lastIndex = tagIndex + fullTag.length;

    if (stripStack.length === 0) {
      result += textBetween;
    }

    if (isClosing) {
      if (stripStack.length > 0) {
        const lastIdx = stripStack.lastIndexOf(tagName);
        if (lastIdx !== -1) {
          stripStack.splice(lastIdx);
        }
      } else {
        result += fullTag;
      }
      continue;
    }

    if (stripStack.length > 0) {
      // Break out of stripping if an article or main container is encountered, avoiding
      // cases where an unclosed preceding nav tag swallows the entire article body.
      if (tagName === "article" || tagName === "main") {
        stripStack.length = 0;
        result += fullTag;
      } else if (!isSelfClosing) {
        stripStack.push(tagName);
      }
      continue;
    }

    const isNegativeTag = STRIP_TAGS.has(tagName);
    const isNegativeClassOrId =
      tagName !== "article" &&
      tagName !== "main" &&
      tagName !== "body" &&
      tagName !== "html" &&
      matchesNegativeClassOrId(attrs);

    if (isNegativeTag || isNegativeClassOrId) {
      if (!isSelfClosing) {
        stripStack.push(tagName);
      }
      continue;
    }

    result += fullTag;
  }

  if (stripStack.length === 0 && lastIndex < withoutComments.length) {
    result += withoutComments.slice(lastIndex);
  }

  return result;
}

function extractContainer(source: string, startPos: number, tagName: string): string {
  const openTagEnd = source.indexOf(">", startPos);
  if (openTagEnd === -1) {
    return source.slice(startPos);
  }

  const tagPattern = new RegExp(`<(/?)${tagName}\\b[^>]*>`, "gi");
  tagPattern.lastIndex = openTagEnd + 1;

  let depth = 1;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(source)) !== null) {
    const isClosing = match[1] === "/";
    const isSelfClosing = match[0].endsWith("/>");

    if (isClosing) {
      depth--;
      if (depth === 0) {
        return source.slice(startPos, match.index + match[0].length);
      }
    } else if (!isSelfClosing) {
      depth++;
    }
  }

  return source.slice(startPos);
}

function evaluateCandidate(candidateHtml: string, tagName: string): Candidate {
  // Match paragraphs tolerantly to handle unclosed tags or paragraphs preceding other block elements
  const pRegex = /<p\b[^>]*>([\s\S]*?)(?:<\/p>|(?=<p\b|$))/gi;
  let pTextCombined = "";
  let pMatch: RegExpExecArray | null;

  while ((pMatch = pRegex.exec(candidateHtml)) !== null) {
    const rawContent = pMatch[1] ?? "";
    const cleanP = decodeEntities(rawContent.replace(/<[^>]*>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (cleanP.length > 0) {
      pTextCombined += " " + cleanP;
    }
  }

  const aRegex = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let linkTextLength = 0;
  let aMatch: RegExpExecArray | null;

  while ((aMatch = aRegex.exec(candidateHtml)) !== null) {
    const rawLinkText = aMatch[1] ?? "";
    const cleanLink = decodeEntities(rawLinkText.replace(/<[^>]*>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    linkTextLength += cleanLink.length;
  }

  const totalText = decodeEntities(candidateHtml.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
  const totalTextLength = totalText.length;
  const pTextLength = pTextCombined.trim().length;

  const linkDensity = totalTextLength > 0 ? Math.min(1, linkTextLength / totalTextLength) : 0;

  // Base score prioritises paragraph text volume while strongly penalising link density
  const baseLength = pTextLength > 0 ? pTextLength : totalTextLength;
  let score = baseLength * (1 - linkDensity);

  if (tagName === "article") {
    score *= 1.5;
  } else if (tagName === "main" || tagName === "[role=main]") {
    score *= 1.3;
  }

  return {
    tag: tagName,
    html: candidateHtml,
    pTextLength,
    totalTextLength,
    linkTextLength,
    linkDensity,
    score
  };
}

function findBestCandidate(cleanedHtml: string): Candidate {
  const candidates: Candidate[] = [];

  const articleRegex = /<article\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = articleRegex.exec(cleanedHtml)) !== null) {
    const container = extractContainer(cleanedHtml, match.index, "article");
    candidates.push(evaluateCandidate(container, "article"));
  }

  const roleMainRegex = /<([a-zA-Z0-9:-]+)\b[^>]*\brole=["']main["'][^>]*>/gi;
  while ((match = roleMainRegex.exec(cleanedHtml)) !== null) {
    const tag = match[1]!.toLowerCase();
    const container = extractContainer(cleanedHtml, match.index, tag);
    candidates.push(evaluateCandidate(container, "[role=main]"));
  }

  const mainRegex = /<main\b[^>]*>/gi;
  while ((match = mainRegex.exec(cleanedHtml)) !== null) {
    const container = extractContainer(cleanedHtml, match.index, "main");
    candidates.push(evaluateCandidate(container, "main"));
  }

  const divRegex = /<div\b[^>]*>/gi;
  let divCount = 0;
  while ((match = divRegex.exec(cleanedHtml)) !== null && divCount < 30) {
    divCount++;
    const container = extractContainer(cleanedHtml, match.index, "div");
    if (container.includes("<p") || container.includes("<table")) {
      candidates.push(evaluateCandidate(container, "div"));
    }
  }

  if (candidates.length === 0) {
    return evaluateCandidate(cleanedHtml, "body");
  }

  let best = candidates[0]!;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (c.score > best.score) {
      best = c;
    }
  }

  return best;
}

function extractArticleText(candidateHtml: string, title: string): string {
  const content = unprotectCode(candidateHtml);

  const tagOrBreakRegex = /<(\/)?([a-zA-Z0-9:-]+)((?:\s+[^"'/>]*(?:(?:'[^']*'|"[^"]*")[^"'/>]*)*)?)\s*(\/?)>|<br\s*\/?>/gi;

  const paragraphs: string[] = [];
  let currentBuffer = "";
  let lastIndex = 0;

  let match: RegExpExecArray | null;

  while ((match = tagOrBreakRegex.exec(content)) !== null) {
    const textChunk = content.slice(lastIndex, match.index);
    lastIndex = match.index + match[0].length;

    if (textChunk.length > 0) {
      currentBuffer += textChunk;
    }

    const matchedTag = match[0].toLowerCase();
    if (matchedTag.startsWith("<br")) {
      currentBuffer += "\n";
      continue;
    }

    const tagName = match[2] ? match[2].toLowerCase() : "";

    if (CELL_TAGS.has(tagName)) {
      currentBuffer += " ";
      continue;
    }

    if (BLOCK_TAGS.has(tagName)) {
      const trimmed = decodeEntities(currentBuffer.replace(/<[^>]*>/g, ""))
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s+/g, "\n")
        .trim();

      if (trimmed.length > 0) {
        paragraphs.push(trimmed);
      }
      currentBuffer = "";
    }
  }

  if (lastIndex < content.length) {
    currentBuffer += content.slice(lastIndex);
  }

  const finalTrimmed = decodeEntities(currentBuffer.replace(/<[^>]*>/g, ""))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();

  if (finalTrimmed.length > 0) {
    paragraphs.push(finalTrimmed);
  }

  /**
   * Omit the first paragraph when it duplicates the standalone title — including
   * when it is the only one. Requiring a second paragraph meant a page that was
   * all script came back with its own title as its body text, so a page with
   * nothing to read reported two words of content and the title twice.
   */
  if (paragraphs.length >= 1 && title.trim().length > 0) {
    const firstPara = paragraphs[0]!;
    if (firstPara.toLowerCase() === title.trim().toLowerCase()) {
      paragraphs.shift();
    }
  }

  return paragraphs.join("\n\n");
}

function countWords(str: string): number {
  const trimmed = str.trim();
  if (trimmed === "") {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

function extractTitle(html: string): string {
  const ogTitleMatch =
    html.match(/<meta\b[^>]*?(?:property=["']og:title["']|name=["']twitter:title["'])[^>]*?content=["']([^"']+)["']/i) ??
    html.match(/<meta\b[^>]*?content=["']([^"']+)["'][^>]*?(?:property=["']og:title["']|name=["']twitter:title["'])/i);
  if (ogTitleMatch) {
    const raw = ogTitleMatch[1] ?? "";
    const clean = decodeEntities(raw).replace(/\s+/g, " ").trim();
    if (clean.length > 0) {
      return clean;
    }
  }

  const articleH1Match = html.match(/<article\b[^>]*>[\s\S]*?<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (articleH1Match) {
    const raw = articleH1Match[1] ?? "";
    const clean = decodeEntities(raw.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (clean.length > 0) {
      return clean;
    }
  }

  const h1Match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    const raw = h1Match[1] ?? "";
    const clean = decodeEntities(raw.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (clean.length > 0) {
      return clean;
    }
  }

  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const raw = titleMatch[1] ?? "";
    const clean = decodeEntities(raw.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (clean.length > 0) {
      return clean;
    }
  }

  return "";
}

function cleanByline(raw: string): string {
  let text = decodeEntities(raw).replace(/\s+/g, " ").trim();
  if (/^by\s+/i.test(text)) {
    text = text.replace(/^by\s+/i, "").trim();
  }
  return text;
}

function extractByline(html: string): string | null {
  const metaAuthorMatch =
    html.match(/<meta\b[^>]*?(?:name=["']author["']|property=["']article:author["'])[^>]*?content=["']([^"']+)["']/i) ??
    html.match(/<meta\b[^>]*?content=["']([^"']+)["'][^>]*?(?:name=["']author["']|property=["']article:author["'])/i);
  if (metaAuthorMatch) {
    const raw = metaAuthorMatch[1] ?? "";
    const clean = cleanByline(raw);
    if (clean.length > 0) {
      return clean;
    }
  }

  const relAuthorMatch = html.match(/<[a-zA-Z0-9:-]+\b[^>]*?(?:rel=["']author["']|itemprop=["']author["'])[^>]*>([\s\S]*?)<\/[a-zA-Z0-9:-]+>/i);
  if (relAuthorMatch) {
    const raw = relAuthorMatch[1] ?? "";
    const clean = cleanByline(raw.replace(/<[^>]*>/g, ""));
    if (clean.length > 0) {
      return clean;
    }
  }

  const classAuthorMatch = html.match(/<[a-zA-Z0-9:-]+\b[^>]*class=["'][^"']*\b(?:byline|author)\b[^"']*["'][^>]*>([\s\S]*?)<\/[a-zA-Z0-9:-]+>/i);
  if (classAuthorMatch) {
    const raw = classAuthorMatch[1] ?? "";
    const clean = cleanByline(raw.replace(/<[^>]*>/g, ""));
    if (clean.length > 0) {
      return clean;
    }
  }

  return null;
}

function extractPublishedAt(html: string): string | null {
  const timeMatch = html.match(/<time\b[^>]*>([\s\S]*?)<\/time>/i);
  if (timeMatch) {
    const inner = (timeMatch[1] ?? "").replace(/<[^>]*>/g, "");
    const cleanInner = decodeEntities(inner).replace(/\s+/g, " ").trim();
    if (cleanInner.length > 0) {
      return cleanInner;
    }
    const dtAttr = getAttribute(timeMatch[0]!, "datetime");
    if (dtAttr && dtAttr.trim().length > 0) {
      return dtAttr.trim();
    }
  }

  const metaDateMatch =
    html.match(/<meta\b[^>]*?(?:property=["']article:published_time["']|name=["'](?:date|pubdate)["'])[^>]*?content=["']([^"']+)["']/i) ??
    html.match(/<meta\b[^>]*?content=["']([^"']+)["'][^>]*?(?:property=["']article:published_time["']|name=["'](?:date|pubdate)["'])/i);
  if (metaDateMatch) {
    const raw = metaDateMatch[1] ?? "";
    const clean = decodeEntities(raw).replace(/\s+/g, " ").trim();
    if (clean.length > 0) {
      return clean;
    }
  }

  const itempropMatch = html.match(/<[a-zA-Z0-9:-]+\b[^>]*itemprop=["']datePublished["'][^>]*>([\s\S]*?)<\/[a-zA-Z0-9:-]+>/i);
  if (itempropMatch) {
    const raw = (itempropMatch[1] ?? "").replace(/<[^>]*>/g, "");
    const clean = decodeEntities(raw).replace(/\s+/g, " ").trim();
    if (clean.length > 0) {
      return clean;
    }
  }

  const classDateMatch = html.match(/<[a-zA-Z0-9:-]+\b[^>]*class=["'][^"']*\b(?:published|post-date|entry-date)\b[^"']*["'][^>]*>([\s\S]*?)<\/[a-zA-Z0-9:-]+>/i);
  if (classDateMatch) {
    const raw = (classDateMatch[1] ?? "").replace(/<[^>]*>/g, "");
    const clean = decodeEntities(raw).replace(/\s+/g, " ").trim();
    if (clean.length > 0) {
      return clean;
    }
  }

  return null;
}

function resolveAndFilterLink(
  rawHref: string | null,
  rawText: string,
  baseUrl: string
): { readonly href: string; readonly text: string } | null {
  if (!rawHref) {
    return null;
  }

  const trimmed = rawHref.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:") ||
    lower.startsWith("sms:")
  ) {
    return null;
  }

  let resolved: URL;
  try {
    resolved = new URL(trimmed, baseUrl);
  } catch {
    return null;
  }

  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return null;
  }

  resolved.hash = "";

  const href = resolved.toString();
  const text = decodeEntities(rawText.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

  return { href, text };
}

function collectLinks(
  snippet: string,
  baseUrl: string
): { readonly href: string; readonly text: string }[] {
  const aRegex = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
  const links: { readonly href: string; readonly text: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = aRegex.exec(snippet)) !== null) {
    const attrs = match[1] ?? "";
    const innerHtml = match[2] ?? "";
    const rawHref = getAttribute(attrs, "href");

    const processed = resolveAndFilterLink(rawHref, innerHtml, baseUrl);
    if (processed) {
      links.push(processed);
    }
  }

  return links;
}

function extractAllLinks(
  articleHtml: string,
  fullHtml: string,
  baseUrl: string
): readonly { readonly href: string; readonly text: string }[] {
  const articleLinks = collectLinks(articleHtml, baseUrl);
  const fullLinks = collectLinks(fullHtml, baseUrl);

  const seen = new Set<string>();
  const result: { readonly href: string; readonly text: string }[] = [];

  for (let i = 0; i < articleLinks.length; i++) {
    const link = articleLinks[i]!;
    if (!seen.has(link.href)) {
      seen.add(link.href);
      result.push(link);
      if (result.length >= 60) {
        return result;
      }
    }
  }

  for (let i = 0; i < fullLinks.length; i++) {
    const link = fullLinks[i]!;
    if (!seen.has(link.href)) {
      seen.add(link.href);
      result.push(link);
      if (result.length >= 60) {
        return result;
      }
    }
  }

  return result;
}

export function extractPage(html: string, baseUrl: string): ExtractedPage {
  let truncated = false;
  let workHtml = html;

  if (workHtml.length > MAX_HTML_LENGTH) {
    workHtml = workHtml.slice(0, MAX_HTML_LENGTH);
    truncated = true;
  }

  workHtml = workHtml.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  let scriptChars = 0;
  const scriptMatches = workHtml.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi);
  if (scriptMatches) {
    for (let i = 0; i < scriptMatches.length; i++) {
      scriptChars += scriptMatches[i]!.length;
    }
  }
  const isMostlyScript = scriptChars > 500 && scriptChars / Math.max(1, workHtml.length) > 0.4;

  const title = extractTitle(workHtml);
  const byline = extractByline(workHtml);
  const publishedAt = extractPublishedAt(workHtml);

  const codeProtected = protectCodeBlocks(workHtml);
  const cleanedHtml = stripUnwantedElements(codeProtected);
  const bestCandidate = findBestCandidate(cleanedHtml);

  const text = extractArticleText(bestCandidate.html, title);
  const words = countWords(text);

  const isLowConfidence = words < 200 || bestCandidate.linkDensity > 0.5;
  const confidence: "high" | "low" = isLowConfidence ? "low" : "high";

  let note: string;
  if (isMostlyScript && words < 50) {
    note = "The page was mostly script with no readable article text.";
  } else if (truncated && isLowConfidence) {
    note = "This page was too long to read in full, so it was truncated after the first 2 MB, and what was read holds under 200 words.";
  } else if (truncated) {
    note = "This page was too long to read in full, so it was truncated after the first 2 MB.";
  } else if (words === 0) {
    note = "No article content was found on the page.";
  } else if (bestCandidate.linkDensity > 0.5 && words < 200) {
    note = "Low confidence extraction: the content has high link density and under 200 words.";
  } else if (bestCandidate.linkDensity > 0.5) {
    note = "Low confidence extraction: the content has high link density over 50 percent.";
  } else if (words < 200) {
    note = "Low confidence extraction: the content has under 200 words.";
  } else {
    note = "Extracted article content from the main container.";
  }

  const links = extractAllLinks(bestCandidate.html, workHtml, baseUrl);

  return {
    title,
    byline,
    publishedAt,
    text,
    words,
    links,
    confidence,
    note
  };
}
