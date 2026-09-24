import { describe, expect, it } from "vitest";
import { extractPage } from "./page-extract.js";

function createRepeatParagraph(wordCount: number): string {
  const words = ["market", "supply", "demand", "capital", "growth", "revenue", "margin", "trade", "export", "balance"];
  const result: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    result.push(words[i % words.length]!);
  }
  return result.join(" ") + ".";
}

describe("page-extract", () => {
  it("extracts clean article text from a document with navigation, header, sidebar and footer", () => {
    const paraOne = createRepeatParagraph(120);
    const paraTwo = createRepeatParagraph(110);

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Q3 Logistics Review | Commercial Outlook</title>
        <meta name="author" content="Jane Doe" />
        <meta property="article:published_time" content="14 October 2024" />
      </head>
      <body>
        <header>
          <div class="site-banner">Special Offer: Sign up today</div>
          <nav>
            <a href="/home">Home</a>
            <a href="/sectors">Sectors</a>
          </nav>
        </header>
        <div class="layout">
          <aside class="sidebar-widget">
            <h3>Top Stories</h3>
            <a href="/story-a">Story A</a>
          </aside>
          <article>
            <h1>Q3 Logistics Review</h1>
            <p>${paraOne}</p>
            <p>${paraTwo} For details see <a href="/reports/2024-q3">the full report</a>.</p>
          </article>
          <div class="share-buttons-promo">
            <a href="/share">Share on Twitter</a>
          </div>
        </div>
        <footer>
          <p>Copyright 2024. All rights reserved.</p>
          <a href="/terms">Terms of Service</a>
        </footer>
      </body>
      </html>
    `;

    const result = extractPage(html, "https://example.co.uk/articles/index.html");

    expect(result.title).toBe("Q3 Logistics Review");
    expect(result.byline).toBe("Jane Doe");
    expect(result.publishedAt).toBe("14 October 2024");
    expect(result.confidence).toBe("high");
    expect(result.words).toBeGreaterThanOrEqual(200);
    expect(result.text).toContain(paraOne);
    expect(result.text).toContain("For details see the full report.");
    expect(result.text).not.toContain("Special Offer");
    expect(result.text).not.toContain("Top Stories");
    expect(result.text).not.toContain("Copyright 2024");

    expect(result.links.length).toBeGreaterThan(0);
    expect(result.links[0]!.href).toBe("https://example.co.uk/reports/2024-q3");
    expect(result.links[0]!.text).toBe("the full report");
  });

  it("flags low confidence on navigation-dominated pages with high link density", () => {
    const html = `
      <html>
      <body>
        <nav class="navigation-menu">
          <a href="/category-1">Category 1</a>
          <a href="/category-2">Category 2</a>
          <a href="/category-3">Category 3</a>
          <a href="/category-4">Category 4</a>
        </nav>
        <div class="cookie-consent-banner">
          <p>We use cookies to enhance your experience.</p>
        </div>
      </body>
      </html>
    `;

    const result = extractPage(html, "https://example.co.uk/browse");

    expect(result.confidence).toBe("low");
    expect(result.words).toBeLessThan(200);
    expect(result.note.length).toBeGreaterThan(0);
  });

  it("identifies single-page applications that consist primarily of script tags", () => {
    const heavyScript = "var bundle = {}; bundle.init = function() { console.log('booting app'); }; ".repeat(20);
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Client Portal</title>
        <script>${heavyScript}</script>
      </head>
      <body>
        <div id="root"></div>
      </body>
      </html>
    `;

    const result = extractPage(html, "https://example.co.uk/app");

    expect(result.title).toBe("Client Portal");
    expect(result.confidence).toBe("low");
    expect(result.words).toBe(0);
    expect(result.text).toBe("");
    expect(result.note).toContain("mostly script");
  });

  it("preserves article text following a code snippet that contains an unescaped article tag", () => {
    const paraLeading = createRepeatParagraph(110);
    const paraTrailing = createRepeatParagraph(110);

    const html = `
      <article>
        <h1>Technical Tutorial</h1>
        <p>${paraLeading}</p>
        <pre><code>&lt;article&gt;sample code</article></code></pre>
        <p>${paraTrailing}</p>
      </article>
    `;

    const result = extractPage(html, "https://example.co.uk/docs/tutorial");

    expect(result.confidence).toBe("high");
    expect(result.text).toContain(paraLeading);
    expect(result.text).toContain("sample code");
    expect(result.text).toContain(paraTrailing);
  });

  it("tolerates unclosed and nested paragraph markup without loss of content", () => {
    const html = `
      <article>
        <p>Paragraph one with unclosed opening tag
        <p>Paragraph two following immediately</p>
        <p>Paragraph three with &amp; &lt;special&gt; &quot;entities&quot; and &#39;quotes&#39;.</p>
      </article>
    `;

    const result = extractPage(html, "https://example.co.uk/sloppy");

    expect(result.text).toContain("Paragraph one with unclosed opening tag");
    expect(result.text).toContain("Paragraph two following immediately");
    expect(result.text).toContain('Paragraph three with & <special> "entities" and \'quotes\'.');
    expect(result.text.split("\n\n").length).toBe(3);
  });

  it("extracts tabular data from documents built without paragraph tags", () => {
    const html = `
      <table>
        <tr><td>Quarterly Output</td><td>£450,000</td></tr>
        <tr><td>Operating Expenses</td><td>£120,000</td></tr>
        <tr><td>Retained Earnings</td><td>£330,000</td></tr>
      </table>
    `;

    const result = extractPage(html, "https://example.co.uk/accounts");

    expect(result.text).toContain("Quarterly Output £450,000");
    expect(result.text).toContain("Operating Expenses £120,000");
    expect(result.text).toContain("Retained Earnings £330,000");
  });

  it("resolves relative links against complex base urls and filters non-web schemes", () => {
    const html = `
      <article>
        <p>References and footnotes:</p>
        <p>
          <a href="relative-item">Next Page</a>
          <a href="/absolute-root">Root</a>
          <a href="//cdn.example.co.uk/assets">Protocol Relative</a>
          <a href="javascript:void(0)">Ignore JS</a>
          <a href="mailto:team@example.co.uk">Ignore Mailto</a>
          <a href="#local-hash">Ignore Anchor</a>
          <a href="https://partner.com/report#appendix">External with Anchor</a>
        </p>
      </article>
    `;

    const result = extractPage(html, "https://example.co.uk/briefings/q3?tab=summary&mode=view");
    const hrefs = result.links.map(l => l.href);

    expect(hrefs).toContain("https://example.co.uk/briefings/relative-item");
    expect(hrefs).toContain("https://example.co.uk/absolute-root");
    expect(hrefs).toContain("https://cdn.example.co.uk/assets");
    expect(hrefs).toContain("https://partner.com/report");

    for (const href of hrefs) {
      expect(href.startsWith("http://") || href.startsWith("https://")).toBe(true);
      expect(href).not.toContain("#");
      expect(href.toLowerCase()).not.toContain("javascript:");
      expect(href.toLowerCase()).not.toContain("mailto:");
    }
  });

  it("caps work and documents truncation when processing oversized html input", () => {
    const repeatedChunk = "<p>" + createRepeatParagraph(50) + "</p>\r\n";
    const largeHtml = "<article>" + repeatedChunk.repeat(6000) + "</article>";

    expect(largeHtml.length).toBeGreaterThan(2_000_000);

    const result = extractPage(largeHtml, "https://example.co.uk/large");

    expect(result.words).toBeGreaterThan(200);
    expect(result.note).toContain("truncated");
  });
});
