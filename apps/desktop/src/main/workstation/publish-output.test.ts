import { describe, expect, it } from "vitest";
import { publishOutput } from "./publish-output.js";
import type { PublishInput } from "./publish-output.js";

describe("publishOutput", () => {
  it("escapes script tags in body text and emits no script elements in HTML", () => {
    const input: PublishInput = {
      title: "Security Check",
      body: "Testing script injection: <script>alert(1)</script> and bold **text**.",
      format: "html",
      author: "Amber",
      at: 1700000000000,
      sources: [],
    };

    const result = publishOutput(input);

    expect(result.files.length).toBe(1);
    const file = result.files[0]!;
    expect(file.relativePath).toBe("security-check.html");
    expect(file.contents).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(file.contents).not.toContain("<script>");
    expect(file.contents).not.toContain("</script>");
    expect(file.contents).toContain("<strong>text</strong>");
  });

  it("produces five slides from a five-heading document", () => {
    const body = [
      "# Market Summary",
      "Revenue expanded steadily.",
      "# Customer Retention",
      "Churn decreased to two percent.",
      "# Operational Focus",
      "Fulfillment times improved.",
      "# Capital Allocation",
      "Invested in inventory.",
      "# Next Steps",
      "Expand outreach.",
    ].join("\n\n");

    const input: PublishInput = {
      title: "Quarterly Board Review",
      body,
      format: "slides",
      author: "Amber",
      at: 1700000000000,
      sources: [],
    };

    const result = publishOutput(input);

    expect(result.files.length).toBe(1);
    const file = result.files[0]!;
    expect(file.relativePath).toBe("quarterly-board-review.html");

    const slideMatches = file.contents.match(/class="slide(?:\s|")/g);
    expect(slideMatches?.length).toBe(5);
    expect(file.contents).toContain("1 / 5");
    expect(file.contents).toContain("Market Summary");
    expect(file.contents).toContain("Next Steps");
  });

  it("neutralises javascript and data link schemes to plain text and reports warnings", () => {
    const input: PublishInput = {
      title: "Link Audit",
      body: [
        "Unsafe links: [Malicious Alert](javascript:alert(1)) and [Data Steal](data:text/html,<script>alert(2)</script>).",
        "Safe link: [Official Documentation](https://example.com/docs).",
      ].join("\n\n"),
      format: "html",
      author: "",
      at: 0,
      sources: [],
    };

    const result = publishOutput(input);

    expect(result.files.length).toBe(1);
    const file = result.files[0]!;
    expect(file.contents).not.toContain('href="javascript');
    expect(file.contents).not.toContain('href="data');
    expect(file.contents).toContain("Malicious Alert");
    expect(file.contents).toContain("Data Steal");
    expect(file.contents).toContain('<a href="https://example.com/docs" rel="noopener noreferrer">Official Documentation</a>');
    expect(result.warnings.length).toBe(2);
    // The destination of a markdown link ends at the first unescaped ")", so what
    // was blocked, and what the warning names, is "javascript:alert(1" — the
    // trailing bracket was never part of the target.
    expect(result.warnings[0]!).toContain("javascript:alert(1");
    expect(result.warnings[1]!).toContain("data:text/html");
  });

  it("prepends a title heading and source list for markdown output", () => {
    const input: PublishInput = {
      title: "Weekly Dispatch",
      body: "Key findings from this week's analysis.",
      format: "markdown",
      author: "Amber",
      at: 1700000000000,
      sources: [{ label: "Bank Reconciliation" }, { label: "Inventory Audit" }],
    };

    const result = publishOutput(input);

    expect(result.files.length).toBe(1);
    const file = result.files[0]!;
    expect(file.relativePath).toBe("weekly-dispatch.md");
    expect(file.contents).toBe(
      "# Weekly Dispatch\n\nKey findings from this week's analysis.\n\n## Sources\n\n- Bank Reconciliation\n- Inventory Audit\n"
    );
  });

  it("avoids duplicating title when markdown body already starts with a title heading", () => {
    const input: PublishInput = {
      title: "Existing Title",
      body: "# Existing Title\n\nBody content already has the heading.",
      format: "markdown",
      author: "",
      at: 0,
      sources: [],
    };

    const result = publishOutput(input);

    expect(result.files.length).toBe(1);
    const file = result.files[0]!;
    expect(file.contents).toBe("# Existing Title\n\nBody content already has the heading.\n");
  });

  it("handles empty body safely without crashing and produces a plain notification", () => {
    const input: PublishInput = {
      title: "Blank Case",
      body: "   \n\r\n   ",
      format: "html",
      author: "",
      at: 0,
      sources: [],
    };

    const result = publishOutput(input);

    expect(result.files.length).toBe(1);
    const file = result.files[0]!;
    expect(file.contents).toContain("This output is empty.");
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]!).toContain("empty");
  });

  it("caps oversized inputs at 500,000 characters and records the cut length", () => {
    const largeBody = "A".repeat(500_500);
    const input: PublishInput = {
      title: "Large Report",
      body: largeBody,
      format: "markdown",
      author: "",
      at: 0,
      sources: [],
    };

    const result = publishOutput(input);

    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]!).toContain("500,000");
    expect(result.warnings[0]!).toContain("cut 500 characters");
    expect(result.files.length).toBe(1);
  });

  it("closes unclosed code fences at end of input without error", () => {
    const input: PublishInput = {
      title: "Unclosed Code",
      body: "```typescript\nconst message = 'incomplete';\n",
      format: "html",
      author: "",
      at: 0,
      sources: [],
    };

    const result = publishOutput(input);

    expect(result.files.length).toBe(1);
    const file = result.files[0]!;
    expect(file.contents).toContain('<pre><code class="language-typescript">const message = \'incomplete\';');
    expect(file.contents).toContain("</code></pre>");
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]!).toContain("unclosed code block");
  });

  it("normalises Windows line endings and cleans punctuation in filenames", () => {
    const input: PublishInput = {
      title: 'Q3 <Review> & "Plan" 🚀',
      body: "Line 1\r\nLine 2\r\nLine 3",
      format: "html",
      author: "",
      at: 0,
      sources: [],
    };

    const result = publishOutput(input);

    expect(result.files.length).toBe(1);
    const file = result.files[0]!;
    expect(file.relativePath).toBe("q3-review-plan.html");
    expect(file.contents).toContain("Q3 &lt;Review&gt; &amp; &quot;Plan&quot; 🚀");
    expect(file.contents).not.toContain("\r");
  });

  it("turns a body with no headings into a single slide", () => {
    const input: PublishInput = {
      title: "Single View",
      body: "This is a single summary paragraph without any headings.",
      format: "slides",
      author: "",
      at: 0,
      sources: [],
    };

    const result = publishOutput(input);

    expect(result.files.length).toBe(1);
    const file = result.files[0]!;
    const slideMatches = file.contents.match(/class="slide(?:\s|")/g);
    expect(slideMatches?.length).toBe(1);
    expect(file.contents).toContain("1 / 1");
  });
});
