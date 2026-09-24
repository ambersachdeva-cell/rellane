import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { inline, Markdown } from "./markdown";

/**
 * The inline pass is the part with the interesting edges, and it returns React
 * elements rather than a string — which is the point. Asserting on the shape of
 * what comes back also proves there is no HTML being built from model output.
 */
function shapeOf(text: string): string[] {
  return inline(text, "t").map((node) => {
    if (typeof node === "string") return node === "" ? "∅" : `text:${node}`;
    const element = node as { type: string; props: { children: string } };
    return `${element.type}:${element.props.children}`;
  });
}

describe("rendering a model's inline marks", () => {
  it("makes bold text bold", () => {
    // Answers came back as literal **IMG_9010.HEIC**, which makes a careful
    // reply look like a bug in the thing that wrote it.
    expect(shapeOf("Two files: **IMG_9010.HEIC** arrived.")).toEqual([
      "text:Two files: ",
      "strong:IMG_9010.HEIC",
      "text: arrived."
    ]);
  });

  it("renders inline code", () => {
    expect(shapeOf("Run `agy --version` first.")).toEqual([
      "text:Run ",
      "code:agy --version",
      "text: first."
    ]);
  });

  it("closes two pairs on one line rather than swallowing the middle", () => {
    // A greedy pattern would match from the first ** to the last and eat the
    // text between them.
    expect(shapeOf("**one** and **two**")).toEqual([
      "∅",
      "strong:one",
      "text: and ",
      "strong:two",
      "∅"
    ]);
  });

  it("leaves a lone asterisk alone", () => {
    expect(shapeOf("2 * 3 = 6")).toEqual(["text:2 * 3 = 6"]);
  });

  it("leaves empty marks as literal text", () => {
    // `****` is not bold with nothing in it; it is four asterisks.
    expect(shapeOf("****")).toEqual(["text:****"]);
  });

  it("returns elements, never markup", () => {
    // The reason there is no dangerouslySetInnerHTML anywhere near this: model
    // output is untrusted, and a general renderer turns it into arbitrary HTML.
    const nodes = inline("**bold** and <script>alert(1)</script>", "t");
    const text = nodes.filter((node) => typeof node === "string").join("");

    expect(text).toContain("<script>");
    expect(nodes.some((node) => typeof node === "object")).toBe(true);
  });
});

describe("passive reading of workroom output", () => {
  const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

  it("distinguishes headings, paragraphs and numbered steps without losing numbering", () => {
    const html = render("# Review\n\nKeep **both** options.\n\n3. First pending step\n5. Later step\n- A separate note");
    expect(html).toContain('<h3 class="md__heading">Review</h3>');
    expect(html).toContain("<strong>both</strong>");
    expect(html).toContain('<ol class="md__list"><li value="3">First pending step</li><li value="5">Later step</li></ol>');
    expect(html).toContain('<ul class="md__list"><li>A separate note</li></ul>');
  });

  it("keeps fenced code literal, including indentation, markup and shorter fences", () => {
    const html = render("````ts\n  const x = '<img src=x>';\n```\n**literal**\n````\n\nAfterwards");
    expect(html).toContain("  const x = &#x27;&lt;img src=x&gt;&#x27;;\n```\n**literal**");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<strong>");
    expect(html).toContain('</code></pre><p class="md__p">Afterwards</p>');
  });

  it("preserves an unfinished code block and does not interpret headings inside it", () => {
    const html = render("~~~\n# a comment\n  ₹5000\nहिंदी");
    expect(html).toContain("# a comment\n  ₹5000\nहिंदी</code>");
    expect(html).not.toContain("<h3");
  });

  it("never creates active HTML, images or navigable links from model output", () => {
    const html = render('<script>alert(1)</script>\n\n<img src="https://example.invalid/pixel">\n\n[open](javascript:alert(1))\n\n![pixel](https://example.invalid/pixel)\n\n**<iframe src=x>**');
    expect(html).not.toMatch(/<(?:script|img|iframe|a)\b/u);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("[open](javascript:alert(1))");
    expect(html).toContain("![pixel](https://example.invalid/pixel)");
    expect(html).toContain("<strong>&lt;iframe src=x&gt;</strong>");
  });
});
