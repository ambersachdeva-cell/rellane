import { describe, expect, it } from "vitest";
import { detectFormat, parseDocument } from "./universal-parser.js";

describe("detectFormat", () => {
  it("detects format from standard file extensions regardless of case", () => {
    expect(detectFormat("brief.md")).toBe("markdown");
    expect(detectFormat("DATA.CSV")).toBe("csv");
    expect(detectFormat("metrics.tsv")).toBe("tsv");
    expect(detectFormat("config.json")).toBe("json");
    expect(detectFormat("events.jsonl")).toBe("jsonl");
    expect(detectFormat("index.html")).toBe("html");
    expect(detectFormat("proposal.docx")).toBe("docx");
    expect(detectFormat("contract.pdf")).toBe("pdf");
    expect(detectFormat("notes.txt")).toBe("text");
  });

  it("detects format from authoritative MIME types", () => {
    expect(detectFormat(undefined, "text/csv")).toBe("csv");
    expect(detectFormat(undefined, "application/pdf")).toBe("pdf");
    expect(detectFormat(undefined, "application/json")).toBe("json");
    expect(detectFormat(undefined, "text/html; charset=utf-8")).toBe("html");
  });

  it("detects format from magic bytes and content previews", () => {
    expect(detectFormat(undefined, undefined, "%PDF-1.4 header")).toBe("pdf");
    expect(detectFormat(undefined, undefined, "<!DOCTYPE html><html><body>Test</body></html>")).toBe("html");
    expect(detectFormat(undefined, undefined, "PK\x03\x04...word/document.xml")).toBe("docx");
    expect(detectFormat(undefined, undefined, "<?xml version='1.0'?><w:document><w:p/></w:document>")).toBe("docx");
  });

  it("falls back to plain text when format cannot be determined", () => {
    expect(detectFormat()).toBe("text");
    expect(detectFormat("archive.unknown")).toBe("text");
  });
});

describe("CSV and TSV parsing", () => {
  it("parses standard CSV with column alignment", () => {
    const csv = "Name,Role,City\nAlice,Lead Architect,London\nBob,Security Engineer,Bristol";
    const doc = parseDocument(csv, { filename: "team.csv" });

    expect(doc.format).toBe("csv");
    expect(doc.tableCount).toBe(1);
    expect(doc.markdown).toContain("| Name | Role | City |");
    expect(doc.markdown).toContain("| Alice | Lead Architect | London |");
    expect(doc.markdown).toContain("| Bob | Security Engineer | Bristol |");
  });

  it("handles embedded commas, escaped quotes, and newlines inside quoted fields", () => {
    const csv = 'Client,Description,Value\n"Acme, Inc.","Q3 review\nDelivered on schedule","£50,000"\n"Beta ""Corp""",Normal,£10';
    const doc = parseDocument(csv, { filename: "revenue.csv" });

    expect(doc.format).toBe("csv");
    expect(doc.markdown).toContain("| Acme, Inc. | Q3 review<br>Delivered on schedule | £50,000 |");
    expect(doc.markdown).toContain('| Beta "Corp" | Normal | £10 |');
  });

  it("parses tab-separated values correctly", () => {
    const tsv = "Metric\tScore\tStatus\nSpeed\t98\tPass\nAccuracy\t99\tPass";
    const doc = parseDocument(tsv, { filename: "benchmark.tsv" });

    expect(doc.format).toBe("tsv");
    expect(doc.tableCount).toBe(1);
    expect(doc.markdown).toContain("| Metric | Score | Status |");
    expect(doc.markdown).toContain("| Speed | 98 | Pass |");
  });
});

describe("JSON and JSONL parsing", () => {
  it("converts an array of uniform objects into a Markdown table", () => {
    const json = JSON.stringify([
      { id: 101, name: "Atlas", active: true },
      { id: 102, name: "Hermes", active: false }
    ]);
    const doc = parseDocument(json, { filename: "projects.json" });

    expect(doc.format).toBe("json");
    expect(doc.tableCount).toBe(1);
    expect(doc.markdown).toContain("| id | name | active |");
    expect(doc.markdown).toContain("| 101 | Atlas | true |");
    expect(doc.markdown).toContain("| 102 | Hermes | false |");
  });

  it("converts newline-delimited JSON into a unified Markdown table", () => {
    const jsonl = '{"repo":"core","stars":120}\n{"repo":"cli","stars":45}';
    const doc = parseDocument(jsonl, { filename: "repositories.jsonl" });

    expect(doc.format).toBe("jsonl");
    expect(doc.tableCount).toBe(1);
    expect(doc.markdown).toContain("| repo | stars |");
    expect(doc.markdown).toContain("| core | 120 |");
  });

  it("handles corrupted JSON without throwing and notes it in metadata", () => {
    const badJson = "{ invalid: json ";
    const doc = parseDocument(badJson, { filename: "bad.json" });

    expect(doc.format).toBe("json");
    expect(doc.metadata["error"]).toBe("Malformed JSON");
  });
});

describe("HTML parsing", () => {
  it("preserves headers, paragraphs, and links while stripping scripts", () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>System Architecture</title>
          <script>console.log("should be stripped");</script>
          <style>body { color: red; }</style>
        </head>
        <body>
          <h1>System Architecture</h1>
          <p>This is the <strong>primary</strong> workstation architecture.</p>
          <p>Read the <a href="https://example.com/docs">documentation</a> for details.</p>
        </body>
      </html>
    `;
    const doc = parseDocument(html, { mimeType: "text/html" });

    expect(doc.format).toBe("html");
    expect(doc.title).toBe("System Architecture");
    expect(doc.markdown).toContain("# System Architecture");
    expect(doc.markdown).toContain("This is the **primary** workstation architecture.");
    expect(doc.markdown).toContain("[documentation](https://example.com/docs)");
    expect(doc.markdown).not.toContain("should be stripped");
    expect(doc.markdown).not.toContain("color: red");
  });

  it("converts HTML tables into structured Markdown tables", () => {
    const html = `
      <table>
        <tr><th>Tool</th><th>Approved</th></tr>
        <tr><td>Git</td><td>Yes</td></tr>
      </table>
    `;
    const doc = parseDocument(html, { filename: "tools.html" });

    expect(doc.tableCount).toBe(1);
    expect(doc.markdown).toContain("| Tool | Approved |");
    expect(doc.markdown).toContain("| Git | Yes |");
  });
});

describe("DOCX parsing", () => {
  it("extracts headings, paragraphs, and tables from simulated DOCX XML", () => {
    const docxXml = `
      <?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p>
            <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
            <w:r><w:t>Project Brief</w:t></w:r>
          </w:p>
          <w:p>
            <w:r><w:t>Local-first Mac workstation deployment.</w:t></w:r>
          </w:p>
          <w:tbl>
            <w:tr>
              <w:tc><w:p><w:r><w:t>Phase</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>Status</w:t></w:r></w:p></w:tc>
            </w:tr>
            <w:tr>
              <w:tc><w:p><w:r><w:t>Wave 4</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>Active</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
        </w:body>
      </w:document>
    `;
    const doc = parseDocument(docxXml, { filename: "brief.docx" });

    expect(doc.format).toBe("docx");
    expect(doc.title).toBe("Project Brief");
    expect(doc.markdown).toContain("# Project Brief");
    expect(doc.markdown).toContain("Local-first Mac workstation deployment.");
    expect(doc.tableCount).toBe(1);
    expect(doc.markdown).toContain("| Phase | Status |");
    expect(doc.markdown).toContain("| Wave 4 | Active |");
  });
});

describe("PDF stream text extraction", () => {
  it("extracts text from PDF text operators with Tj and TJ kerning arrays", () => {
    const pdfStream = `
      %PDF-1.4
      1 0 obj
      << /Length 200 >>
      stream
      BT
      /F1 14 Tf
      (Executive Summary) Tj
      T*
      [(Rellane ) -150 (executes ) -150 (local ) -150 (workflows.)] TJ
      ET
      endstream
      endobj
    `;
    const doc = parseDocument(pdfStream, { filename: "report.pdf" });

    expect(doc.format).toBe("pdf");
    expect(doc.markdown).toContain("Executive Summary");
    expect(doc.markdown).toContain("Rellane executes local workflows.");
  });
});

describe("Truncation limit", () => {
  it("respects maxChars and updates word count and headings accordingly", () => {
    const longText = "# Header One\n\n" + "Word ".repeat(500);
    const doc = parseDocument(longText, { filename: "large.md", maxChars: 50 });

    expect(doc.markdown.length).toBeLessThanOrEqual(50);
    expect(doc.metadata["truncated"]).toBe(true);
    expect(doc.wordCount).toBeGreaterThan(0);
  });
});

describe("Resilience on edge cases", () => {
  it("handles empty string without throwing", () => {
    const doc = parseDocument("");
    expect(doc.wordCount).toBe(0);
    expect(doc.tableCount).toBe(0);
    expect(doc.markdown).toBe("");
    expect(doc.title).toBe("Untitled Document");
  });

  it("handles empty byte buffer without throwing", () => {
    const doc = parseDocument(new Uint8Array(0));
    expect(doc.wordCount).toBe(0);
    expect(doc.markdown).toBe("");
  });
});
