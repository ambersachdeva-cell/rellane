import { describe, expect, it } from "vitest";
import {
  MAX_MARKDOWN_CHARS,
  parseMarkdown,
  type MdInline,
  type MdNode,
} from "./markdown-tree.js";

function assertSafeInline(inline: MdInline): void {
  const allowedInlineKinds = new Set([
    "text",
    "strong",
    "emphasis",
    "strike",
    "code",
    "link",
    "break",
  ]);
  expect(allowedInlineKinds.has(inline.kind)).toBe(true);

  if (
    inline.kind === "strong" ||
    inline.kind === "emphasis" ||
    inline.kind === "strike" ||
    inline.kind === "link"
  ) {
    for (const child of inline.children) {
      assertSafeInline(child);
    }
  }
}

function assertSafeNode(node: MdNode): void {
  const allowedNodeKinds = new Set([
    "paragraph",
    "heading",
    "code",
    "quote",
    "list",
    "table",
    "rule",
  ]);
  expect(allowedNodeKinds.has(node.kind)).toBe(true);

  if (node.kind === "paragraph" || node.kind === "heading") {
    for (const child of node.children) {
      assertSafeInline(child);
    }
  } else if (node.kind === "quote") {
    for (const child of node.children) {
      assertSafeNode(child);
    }
  } else if (node.kind === "list") {
    for (const item of node.items) {
      for (const child of item) {
        assertSafeNode(child);
      }
    }
  } else if (node.kind === "table") {
    for (const cell of node.head) {
      for (const inline of cell) {
        assertSafeInline(inline);
      }
    }
    for (const row of node.rows) {
      for (const cell of row) {
        for (const inline of cell) {
          assertSafeInline(inline);
        }
      }
    }
  }
}

describe("parseMarkdown", () => {
  it("parses a 2-column table with header and one row as a regression test", () => {
    const source = [
      "| Source | Length |",
      "| --- | --- |",
      "| notes.txt | 452 characters |",
    ].join("\n");

    const nodes = parseMarkdown(source);
    expect(nodes.length).toBe(1);

    const table = nodes[0];
    expect(table?.kind).toBe("table");
    if (table?.kind !== "table") return;

    expect(table.align).toEqual([null, null]);
    expect(table.head.length).toBe(2);
    expect(table.head[0]).toEqual([{ kind: "text", text: "Source" }]);
    expect(table.head[1]).toEqual([{ kind: "text", text: "Length" }]);

    expect(table.rows.length).toBe(1);
    const row = table.rows[0];
    expect(row?.length).toBe(2);
    expect(row?.[0]).toEqual([{ kind: "text", text: "notes.txt" }]);
    expect(row?.[1]).toEqual([{ kind: "text", text: "452 characters" }]);
  });

  it("parses table column alignment correctly", () => {
    const source = [
      "| Left | Right | Center |",
      "|:--|--:|:-:|",
      "| 1 | 2 | 3 |",
    ].join("\n");

    const nodes = parseMarkdown(source);
    expect(nodes.length).toBe(1);

    const table = nodes[0];
    expect(table?.kind).toBe("table");
    if (table?.kind !== "table") return;

    expect(table.align).toEqual(["left", "right", "center"]);
  });

  it("parses the 3-column table from the bug report", () => {
    const source = [
      "| Source | Source ID | Length |",
      "|---|---|---|",
      "| native-meeting-notes.txt [1] | 116dc1f9-... | 452 characters |",
    ].join("\n");

    const nodes = parseMarkdown(source);
    expect(nodes.length).toBe(1);

    const table = nodes[0];
    expect(table?.kind).toBe("table");
    if (table?.kind !== "table") return;

    expect(table.align).toEqual([null, null, null]);
    expect(table.head.length).toBe(3);
    expect(table.rows.length).toBe(1);
    expect(table.rows[0]?.length).toBe(3);
  });

  it("correctly nests lists inside blockquotes inside nested lists", () => {
    const source = [
      "> - Outer item",
      ">   - Nested item",
    ].join("\n");

    const nodes = parseMarkdown(source);
    expect(nodes.length).toBe(1);

    const quote = nodes[0];
    expect(quote?.kind).toBe("quote");
    if (quote?.kind !== "quote") return;

    expect(quote.children.length).toBe(1);
    const outerList = quote.children[0];
    expect(outerList?.kind).toBe("list");
    if (outerList?.kind !== "list") return;
    expect(outerList.ordered).toBe(false);
    expect(outerList.items.length).toBe(1);

    const outerItem = outerList.items[0];
    expect(outerItem).toBeDefined();
    if (!outerItem) return;

    // The item contains its paragraph and the nested list
    expect(outerItem.length).toBe(2);
    expect(outerItem[0]?.kind).toBe("paragraph");

    const nestedList = outerItem[1];
    expect(nestedList?.kind).toBe("list");
    if (nestedList?.kind !== "list") return;
    expect(nestedList.ordered).toBe(false);
    expect(nestedList.items.length).toBe(1);

    const nestedItem = nestedList.items[0];
    expect(nestedItem?.[0]?.kind).toBe("paragraph");
  });

  it("produces strong, emphasis, strike, and code inline kinds", () => {
    const source = "**bold** *em* ~~strike~~ `code`";
    const nodes = parseMarkdown(source);
    expect(nodes.length).toBe(1);

    const p = nodes[0];
    expect(p?.kind).toBe("paragraph");
    if (p?.kind !== "paragraph") return;

    const kinds = p.children.map((c) => c.kind);
    expect(kinds).toContain("strong");
    expect(kinds).toContain("emphasis");
    expect(kinds).toContain("strike");
    expect(kinds).toContain("code");

    const strong = p.children.find((c) => c.kind === "strong");
    expect(strong).toEqual({
      kind: "strong",
      children: [{ kind: "text", text: "bold" }],
    });

    const code = p.children.find((c) => c.kind === "code");
    expect(code).toEqual({
      kind: "code",
      text: "code",
    });
  });

  it("parses fenced code blocks with language labels and without labels", () => {
    const withLang = "```ts\nconst val = 42;\n```";
    const nodesWithLang = parseMarkdown(withLang);
    expect(nodesWithLang.length).toBe(1);
    expect(nodesWithLang[0]).toEqual({
      kind: "code",
      language: "ts",
      text: "const val = 42;\n",
    });

    const withoutLang = "```\nplain content\n```";
    const nodesWithoutLang = parseMarkdown(withoutLang);
    expect(nodesWithoutLang.length).toBe(1);
    expect(nodesWithoutLang[0]).toEqual({
      kind: "code",
      language: null,
      text: "plain content\n",
    });
  });

  it("handles unterminated fences without throwing and yields a code node", () => {
    const unterminated = "```ts\nconst incomplete = true;";
    const nodes = parseMarkdown(unterminated);
    expect(nodes.length).toBe(1);
    expect(nodes[0]?.kind).toBe("code");
    if (nodes[0]?.kind !== "code") return;
    expect(nodes[0].language).toBe("ts");
    expect(nodes[0].text).toBe("const incomplete = true;");
  });

  it("records the starting number of ordered lists", () => {
    const source = "5. Fifth item\n6. Sixth item";
    const nodes = parseMarkdown(source);
    expect(nodes.length).toBe(1);

    const list = nodes[0];
    expect(list?.kind).toBe("list");
    if (list?.kind !== "list") return;
    expect(list.ordered).toBe(true);
    expect(list.start).toBe(5);
    expect(list.items.length).toBe(2);
  });

  it("treats script tags as inert text and never creates executable nodes", () => {
    const malicious = "<script>alert(1)</script>";
    const nodes = parseMarkdown(malicious);

    expect(nodes.length).toBe(1);
    const node = nodes[0];
    expect(node).toBeDefined();
    if (!node) return;

    assertSafeNode(node);
    expect(node.kind).toBe("paragraph");
    if (node.kind !== "paragraph") return;

    expect(node.children).toEqual([
      { kind: "text", text: "<script>alert(1)</script>" },
    ]);
  });

  it("returns a single text paragraph when input exceeds MAX_MARKDOWN_CHARS", () => {
    const oversized = "a".repeat(MAX_MARKDOWN_CHARS + 1);
    const nodes = parseMarkdown(oversized);

    expect(nodes.length).toBe(1);
    expect(nodes[0]).toEqual({
      kind: "paragraph",
      children: [{ kind: "text", text: oversized }],
    });
  });

  it("returns an empty array for empty and whitespace-only input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\t  \r\n  ")).toEqual([]);
  });

  it("parses links carrying href raw without validation", () => {
    const source = "[Documentation](https://example.com/guide)";
    const nodes = parseMarkdown(source);
    expect(nodes.length).toBe(1);

    const p = nodes[0];
    expect(p?.kind).toBe("paragraph");
    if (p?.kind !== "paragraph") return;

    expect(p.children).toEqual([
      {
        kind: "link",
        href: "https://example.com/guide",
        children: [{ kind: "text", text: "Documentation" }],
      },
    ]);
  });

  it("degrades images to text carrying alt text", () => {
    const source = "![Architecture Diagram](diagram.png)";
    const nodes = parseMarkdown(source);
    expect(nodes.length).toBe(1);

    const p = nodes[0];
    expect(p?.kind).toBe("paragraph");
    if (p?.kind !== "paragraph") return;

    expect(p.children).toEqual([
      { kind: "text", text: "Architecture Diagram" },
    ]);
  });

  it("maps softbreak and hardbreak to break inline nodes", () => {
    const soft = "First line\nSecond line";
    const softNodes = parseMarkdown(soft);
    const softP = softNodes[0];
    if (softP?.kind !== "paragraph") throw new Error("Expected paragraph");
    expect(softP.children.some((c) => c.kind === "break")).toBe(true);

    const hard = "First line  \nSecond line";
    const hardNodes = parseMarkdown(hard);
    const hardP = hardNodes[0];
    if (hardP?.kind !== "paragraph") throw new Error("Expected paragraph");
    expect(hardP.children.some((c) => c.kind === "break")).toBe(true);
  });

  it("parses headings and horizontal rules", () => {
    const source = "# Title\n---\n## Subtitle";
    const nodes = parseMarkdown(source);
    expect(nodes.length).toBe(3);

    expect(nodes[0]?.kind).toBe("heading");
    if (nodes[0]?.kind === "heading") {
      expect(nodes[0].level).toBe(1);
    }
    expect(nodes[1]?.kind).toBe("rule");
    expect(nodes[2]?.kind).toBe("heading");
    if (nodes[2]?.kind === "heading") {
      expect(nodes[2].level).toBe(2);
    }
  });

  it("handles binary junk and unbalanced markers without throwing", () => {
    const junk = "\x00\x01\x02\xFF **unclosed bold `unclosed code";
    expect(() => parseMarkdown(junk)).not.toThrow();
    const nodes = parseMarkdown(junk);
    expect(nodes.length).toBeGreaterThan(0);
  });
});
