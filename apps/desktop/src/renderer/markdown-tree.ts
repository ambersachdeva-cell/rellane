/**
 * Typed AST parser for model Markdown output.
 * Produces an inert tree of block and inline nodes using markdown-it,
 * guaranteeing that model responses never construct HTML strings.
 */

import MarkdownIt from "markdown-it";

export type MdAlign = "left" | "right" | "center" | null;

export type MdInline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong"; readonly children: readonly MdInline[] }
  | { readonly kind: "emphasis"; readonly children: readonly MdInline[] }
  | { readonly kind: "strike"; readonly children: readonly MdInline[] }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly href: string; readonly children: readonly MdInline[] }
  | { readonly kind: "break" };

export type MdNode =
  | { readonly kind: "paragraph"; readonly children: readonly MdInline[] }
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly children: readonly MdInline[] }
  | { readonly kind: "code"; readonly language: string | null; readonly text: string }
  | { readonly kind: "quote"; readonly children: readonly MdNode[] }
  | { readonly kind: "list"; readonly ordered: boolean; readonly start: number; readonly items: readonly (readonly MdNode[])[] }
  | { readonly kind: "table"; readonly align: readonly MdAlign[]; readonly head: readonly (readonly MdInline[])[]; readonly rows: readonly (readonly (readonly MdInline[])[])[] }
  | { readonly kind: "rule" };

export const MAX_MARKDOWN_CHARS = 200_000;

// Configured with html:false to prevent raw HTML tokens from entering the tree,
// and linkify:false so unformatted URLs stay inert text.
const md = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
});

type MarkdownItToken = ReturnType<typeof md.parse>[number];

interface InlineFrame {
  readonly type: string;
  readonly token: MarkdownItToken;
  readonly children: MdInline[];
}

interface ParseBlocksResult {
  readonly nodes: readonly MdNode[];
  readonly nextIndex: number;
}

interface ParseTableResult {
  readonly table: MdNode;
  readonly nextIndex: number;
}

function getAttr(token: MarkdownItToken, name: string): string | null {
  if (typeof token.attrGet === "function") {
    const val = token.attrGet(name);
    if (val !== null) return val;
  }
  const attrs = token.attrs;
  if (attrs) {
    for (let i = 0; i < attrs.length; i++) {
      const entry = attrs[i];
      if (entry && entry[0] === name && entry[1] !== undefined) {
        return entry[1];
      }
    }
  }
  return null;
}

function parseAlign(token: MarkdownItToken): MdAlign {
  const style = getAttr(token, "style");
  if (!style) return null;
  const match = /text-align:\s*(left|right|center)/i.exec(style);
  if (match) {
    const val = match[1]?.toLowerCase();
    if (val === "left" || val === "right" || val === "center") {
      return val;
    }
  }
  return null;
}

function finishFrame(frame: InlineFrame): readonly MdInline[] {
  if (frame.type === "strong_open") {
    return [{ kind: "strong", children: frame.children }];
  }
  if (frame.type === "em_open") {
    return [{ kind: "emphasis", children: frame.children }];
  }
  if (frame.type === "s_open") {
    return [{ kind: "strike", children: frame.children }];
  }
  if (frame.type === "link_open") {
    const href = getAttr(frame.token, "href") ?? "";
    return [{ kind: "link", href, children: frame.children }];
  }
  if (frame.children.length > 0) {
    return frame.children;
  }
  if (frame.token.content.length > 0) {
    return [{ kind: "text", text: frame.token.content }];
  }
  return [];
}

function parseInline(tokens: readonly MarkdownItToken[]): readonly MdInline[] {
  const root: MdInline[] = [];
  const stack: InlineFrame[] = [];

  function appendToCurrent(items: readonly MdInline[]): void {
    const top = stack[stack.length - 1];
    const target = top ? top.children : root;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item) {
        target.push(item);
      }
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if (token.type === "text") {
      if (token.content.length > 0) {
        appendToCurrent([{ kind: "text", text: token.content }]);
      }
      continue;
    }

    if (token.type === "code_inline") {
      appendToCurrent([{ kind: "code", text: token.content }]);
      continue;
    }

    if (token.type === "softbreak" || token.type === "hardbreak") {
      appendToCurrent([{ kind: "break" }]);
      continue;
    }

    // Images degrade to plain text with their alt label to prevent remote resource requests.
    if (token.type === "image") {
      let alt = token.content;
      if (!alt && token.children && token.children.length > 0) {
        let joined = "";
        for (let j = 0; j < token.children.length; j++) {
          const child = token.children[j];
          if (child) joined += child.content;
        }
        alt = joined;
      }
      appendToCurrent([{ kind: "text", text: alt }]);
      continue;
    }

    if (token.type.endsWith("_open")) {
      stack.push({
        type: token.type,
        token,
        children: [],
      });
      continue;
    }

    if (token.type.endsWith("_close")) {
      const expectedOpen = token.type.slice(0, -6) + "_open";
      let matchIndex = -1;
      for (let j = stack.length - 1; j >= 0; j--) {
        const frame = stack[j];
        if (frame && frame.type === expectedOpen) {
          matchIndex = j;
          break;
        }
      }

      if (matchIndex >= 0) {
        while (stack.length > matchIndex + 1) {
          const unclosed = stack.pop();
          if (unclosed) {
            const finished = finishFrame(unclosed);
            appendToCurrent(finished);
          }
        }
        const matched = stack.pop();
        if (matched) {
          const finished = finishFrame(matched);
          appendToCurrent(finished);
        }
      } else if (token.content.length > 0) {
        appendToCurrent([{ kind: "text", text: token.content }]);
      }
      continue;
    }

    // Unrecognised inline marks degrade to plain text to prevent silent content loss.
    if (token.content.length > 0) {
      appendToCurrent([{ kind: "text", text: token.content }]);
    }
  }

  while (stack.length > 0) {
    const unclosed = stack.pop();
    if (unclosed) {
      const finished = finishFrame(unclosed);
      appendToCurrent(finished);
    }
  }

  return root;
}

function parseTable(
  tokens: readonly MarkdownItToken[],
  startIndex: number
): ParseTableResult {
  let i = startIndex + 1;
  let inThead = false;
  const alignList: MdAlign[] = [];
  const headCells: (readonly MdInline[])[] = [];
  const rows: (readonly (readonly MdInline[])[])[] = [];
  let currentRow: (readonly MdInline[])[] = [];
  let currentCellInlines: MdInline[] = [];

  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) {
      i++;
      continue;
    }

    if (token.type === "table_close") {
      i++;
      break;
    }

    if (token.type === "thead_open") {
      inThead = true;
      i++;
      continue;
    }

    if (token.type === "thead_close") {
      inThead = false;
      i++;
      continue;
    }

    if (token.type === "tbody_open" || token.type === "tbody_close") {
      i++;
      continue;
    }

    if (token.type === "tr_open") {
      currentRow = [];
      i++;
      continue;
    }

    if (token.type === "tr_close") {
      if (inThead) {
        for (let c = 0; c < currentRow.length; c++) {
          const cell = currentRow[c];
          if (cell) headCells.push(cell);
        }
      } else {
        rows.push(currentRow);
      }
      currentRow = [];
      i++;
      continue;
    }

    if (token.type === "th_open" || token.type === "td_open") {
      currentCellInlines = [];
      if (inThead && token.type === "th_open") {
        alignList.push(parseAlign(token));
      }
      i++;
      continue;
    }

    if (token.type === "th_close" || token.type === "td_close") {
      currentRow.push(currentCellInlines);
      currentCellInlines = [];
      i++;
      continue;
    }

    if (token.type === "inline") {
      currentCellInlines = parseInline(token.children ?? []).slice();
      i++;
      continue;
    }

    if (token.content.length > 0) {
      currentCellInlines.push({ kind: "text", text: token.content });
      i++;
      continue;
    }

    i++;
  }

  // The align array must have exactly one element per column across header and rows.
  const colCount = Math.max(
    alignList.length,
    headCells.length,
    ...rows.map((r) => r.length)
  );
  const align: MdAlign[] = [];
  for (let col = 0; col < colCount; col++) {
    const val = alignList[col];
    align.push(val !== undefined ? val : null);
  }

  const tableNode: MdNode = {
    kind: "table",
    align,
    head: headCells,
    rows,
  };

  return { table: tableNode, nextIndex: i };
}

function parseBlocks(
  tokens: readonly MarkdownItToken[],
  startIndex: number,
  expectedClose: string | null,
  isParentClose?: (token: MarkdownItToken) => boolean
): ParseBlocksResult {
  const nodes: MdNode[] = [];
  let i = startIndex;

  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) {
      i++;
      continue;
    }

    if (expectedClose !== null && token.type === expectedClose) {
      return { nodes, nextIndex: i + 1 };
    }

    if (isParentClose && isParentClose(token)) {
      return { nodes, nextIndex: i };
    }

    if (token.type === "paragraph_open") {
      const inlines: MdInline[] = [];
      i++;
      while (i < tokens.length) {
        const pTok = tokens[i];
        if (!pTok) {
          i++;
          continue;
        }
        if (pTok.type === "paragraph_close") {
          i++;
          break;
        }
        if (pTok.type === "inline") {
          const parsed = parseInline(pTok.children ?? []);
          for (let j = 0; j < parsed.length; j++) {
            const item = parsed[j];
            if (item) inlines.push(item);
          }
        } else if (pTok.content.length > 0) {
          inlines.push({ kind: "text", text: pTok.content });
        }
        i++;
      }
      nodes.push({ kind: "paragraph", children: inlines });
      continue;
    }

    if (token.type === "heading_open") {
      const rawLevel = parseInt(token.tag.slice(1), 10);
      const clampedLevel = Number.isNaN(rawLevel)
        ? 1
        : Math.min(Math.max(rawLevel, 1), 6);
      const level = clampedLevel as 1 | 2 | 3 | 4 | 5 | 6;

      const inlines: MdInline[] = [];
      i++;
      while (i < tokens.length) {
        const hTok = tokens[i];
        if (!hTok) {
          i++;
          continue;
        }
        if (hTok.type === "heading_close") {
          i++;
          break;
        }
        if (hTok.type === "inline") {
          const parsed = parseInline(hTok.children ?? []);
          for (let j = 0; j < parsed.length; j++) {
            const item = parsed[j];
            if (item) inlines.push(item);
          }
        } else if (hTok.content.length > 0) {
          inlines.push({ kind: "text", text: hTok.content });
        }
        i++;
      }
      nodes.push({ kind: "heading", level, children: inlines });
      continue;
    }

    if (token.type === "fence" || token.type === "code_block") {
      const rawInfo = token.info ? token.info.trim() : "";
      const firstWord = rawInfo.length > 0 ? rawInfo.split(/\s+/)[0] : undefined;
      const language = firstWord && firstWord.length > 0 ? firstWord : null;
      nodes.push({
        kind: "code",
        language,
        text: token.content,
      });
      i++;
      continue;
    }

    if (token.type === "hr") {
      nodes.push({ kind: "rule" });
      i++;
      continue;
    }

    if (token.type === "blockquote_open") {
      const quoteResult = parseBlocks(
        tokens,
        i + 1,
        "blockquote_close",
        isParentClose
      );
      nodes.push({
        kind: "quote",
        children: quoteResult.nodes,
      });
      i = quoteResult.nextIndex;
      continue;
    }

    if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
      const ordered = token.type === "ordered_list_open";
      const listClose = ordered ? "ordered_list_close" : "bullet_list_close";
      let start = 1;
      if (ordered) {
        const startAttr = getAttr(token, "start");
        if (startAttr !== null) {
          const parsed = parseInt(startAttr, 10);
          if (!Number.isNaN(parsed)) {
            start = parsed;
          }
        }
      }

      const items: (readonly MdNode[])[] = [];
      i++;
      while (i < tokens.length) {
        const lTok = tokens[i];
        if (!lTok) {
          i++;
          continue;
        }
        if (lTok.type === listClose) {
          i++;
          break;
        }
        if (isParentClose && isParentClose(lTok)) {
          break;
        }

        if (lTok.type === "list_item_open") {
          const itemResult = parseBlocks(
            tokens,
            i + 1,
            "list_item_close",
            (t) =>
              t.type === listClose || (isParentClose ? isParentClose(t) : false)
          );
          items.push(itemResult.nodes);
          i = itemResult.nextIndex;
          continue;
        }

        if (lTok.type === "inline") {
          const parsed = parseInline(lTok.children ?? []);
          if (parsed.length > 0) {
            items.push([{ kind: "paragraph", children: parsed }]);
          }
        }
        i++;
      }

      nodes.push({
        kind: "list",
        ordered,
        start,
        items,
      });
      continue;
    }

    if (token.type === "table_open") {
      const tableResult = parseTable(tokens, i);
      nodes.push(tableResult.table);
      i = tableResult.nextIndex;
      continue;
    }

    if (token.type === "inline") {
      const parsed = parseInline(token.children ?? []);
      if (parsed.length > 0) {
        nodes.push({ kind: "paragraph", children: parsed });
      }
      i++;
      continue;
    }

    // Degrading unexpected block tokens to paragraphs prevents model content from being lost.
    if (token.content.length > 0) {
      nodes.push({
        kind: "paragraph",
        children: [{ kind: "text", text: token.content }],
      });
      i++;
      continue;
    }

    i++;
  }

  return { nodes, nextIndex: i };
}

export function parseMarkdown(source: string): readonly MdNode[] {
  // Guard against pathological input sizes freezing the workstation renderer.
  if (source.length > MAX_MARKDOWN_CHARS) {
    return [
      {
        kind: "paragraph",
        children: [{ kind: "text", text: source }],
      },
    ];
  }

  if (source.trim().length === 0) {
    return [];
  }

  try {
    const tokens = md.parse(source, {});
    const result = parseBlocks(tokens, 0, null);
    return result.nodes;
  } catch {
    // Graceful fallback guarantees this function never throws for any input.
    return [
      {
        kind: "paragraph",
        children: [{ kind: "text", text: source }],
      },
    ];
  }
}
