import { describe, expect, it } from "vitest";
import {
  publishDocument,
  generateHtmlDocument,
  generateSlideDeckHtml,
  generateTypstSource,
  generateMarkdownReport
} from "./document-publisher.js";
import type { PublicationRequest } from "./document-publisher.js";

describe("document-publisher", () => {
  const sampleRequest: PublicationRequest = {
    format: "html",
    title: "Quarterly Architecture Review",
    subtitle: "Local-first workstation execution model",
    author: "Engineering Team",
    date: "2026-09-15",
    theme: "graphite",
    sections: [
      {
        heading: "Executive Summary",
        content:
          "Rellane maintains all model telemetry and subscription operations directly on your Mac.\n\nKey findings indicate **zero cloud relay latency** with full local authority.",
        callout: {
          type: "metric",
          text: "Latency reduced from 420ms to 8ms across all local tool calls"
        }
      },
      {
        heading: "Security and Concurrency",
        content:
          "Each provider session operates in an isolated worker lane without shared mutable buffers.",
        subheadings: [
          {
            title: "Process Isolation",
            body: "Worker processes communicate strictly via standard streams with strict bounds checking."
          }
        ],
        callout: {
          type: "warning",
          text: "Manual approval is mandatory before any filesystem modification."
        }
      }
    ]
  };

  it("generates standalone HTML with embedded print CSS and section content", () => {
    const result = publishDocument(sampleRequest);

    expect(result.format).toBe("html");
    expect(result.filename).toBe("quarterly-architecture-review.html");
    expect(result.mimeType).toBe("text/html");
    expect(result.pageCountEstimate).toBeGreaterThanOrEqual(1);

    const html = result.content;
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Quarterly Architecture Review</title>");
    expect(html).toContain("Executive Summary");
    expect(html).toContain("zero cloud relay latency");
    expect(html).toContain("pub-callout-metric");
    expect(html).toContain("IBM Plex Sans");
    expect(html).toContain("@media print");
    expect(html).toContain("page-break-after: avoid");
    expect(html).toContain("break-after: avoid");
    expect(html).toContain("page-break-inside: avoid");
    expect(html).toContain("size: A4");
  });

  it("generates presentation slide deck with keyboard navigation and slide counter", () => {
    const slideReq: PublicationRequest = {
      ...sampleRequest,
      format: "slides"
    };
    const result = publishDocument(slideReq);

    expect(result.format).toBe("slides");
    expect(result.filename).toBe("quarterly-architecture-review-slides.html");
    expect(result.mimeType).toBe("text/html");
    expect(result.pageCountEstimate).toBe(3);

    const html = generateSlideDeckHtml(slideReq);
    expect(html).toContain("slide-title-slide");
    expect(html).toContain("Quarterly Architecture Review");
    expect(html).toContain("data-slide-index=\"1\"");
    expect(html).toContain("data-slide-index=\"2\"");
    expect(html).toContain("ArrowRight");
    expect(html).toContain("ArrowLeft");
    expect(html).toContain("slide-current");
    expect(html).toContain("slide-total");
    expect(html).toContain("btn-theme");
    expect(html).toContain("dark-mode");
  });

  it("generates valid Typst source with page setup, text styling, and callouts", () => {
    const typstReq: PublicationRequest = {
      ...sampleRequest,
      format: "typst"
    };
    const result = publishDocument(typstReq);

    expect(result.format).toBe("typst");
    expect(result.filename).toBe("quarterly-architecture-review.typ");
    expect(result.mimeType).toBe("text/x-typst");

    const typst = generateTypstSource(typstReq);
    expect(typst).toContain("#set page(");
    expect(typst).toContain('paper: "a4"');
    expect(typst).toContain("#set text(");
    expect(typst).toContain("#set par(");
    expect(typst).toContain("= Executive Summary");
    expect(typst).toContain("= Security and Concurrency");
    expect(typst).toContain("== Process Isolation");
    expect(typst).toContain("#rect(");
    expect(typst).toContain("*Metric:*");
    expect(typst).toContain("*Warning:*");
  });

  it("generates clean GitHub-Flavored Markdown report with metadata frontmatter", () => {
    const mdReq: PublicationRequest = {
      ...sampleRequest,
      format: "markdown"
    };
    const result = publishDocument(mdReq);

    expect(result.format).toBe("markdown");
    expect(result.filename).toBe("quarterly-architecture-review.md");
    expect(result.mimeType).toBe("text/markdown");

    const md = generateMarkdownReport(mdReq);
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain('title: "Quarterly Architecture Review"');
    expect(md).toContain('author: "Engineering Team"');
    expect(md).toContain('date: "2026-09-15"');
    expect(md).toContain("# Quarterly Architecture Review");
    expect(md).toContain("## Executive Summary");
    expect(md).toContain("> [!IMPORTANT]");
    expect(md).toContain("> [!WARNING]");
    expect(md).toContain("### Process Isolation");
    expect(md).toContain("---");
  });

  it("handles custom theme styling variants across HTML, slides, and Typst", () => {
    const editorialReq: PublicationRequest = {
      ...sampleRequest,
      theme: "editorial"
    };
    const classicReq: PublicationRequest = {
      ...sampleRequest,
      theme: "classic"
    };

    const editorialHtml = generateHtmlDocument(editorialReq);
    expect(editorialHtml).toContain("theme-editorial");
    expect(editorialHtml).toContain("IBM Plex Serif");

    const classicHtml = generateHtmlDocument(classicReq);
    expect(classicHtml).toContain("theme-classic");

    const editorialTypst = generateTypstSource(editorialReq);
    expect(editorialTypst).toContain("IBM Plex Serif");
  });

  it("handles empty sections and special characters gracefully without throwing", () => {
    const emptyReq: PublicationRequest = {
      format: "html",
      title: "Empty Brief <test & alert>",
      sections: []
    };

    const html = generateHtmlDocument(emptyReq);
    expect(html).toContain("Empty Brief &lt;test &amp; alert&gt;");
    expect(html).toContain("<!DOCTYPE html>");

    const slides = generateSlideDeckHtml(emptyReq);
    expect(slides).toContain("Empty Brief &lt;test &amp; alert&gt;");

    const typst = generateTypstSource(emptyReq);
    expect(typst).toContain("#set page(");

    const md = generateMarkdownReport(emptyReq);
    expect(md).toContain('title: "Empty Brief <test & alert>"');

    const result = publishDocument(emptyReq);
    expect(result.pageCountEstimate).toBe(1);
  });
});
