import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { $getRoot, $createTextNode, $isElementNode, type LexicalEditor } from "lexical";
import {
  LexicalDocumentEditor,
  checkKnownLimitations,
  inspectMarkdownCompatibility,
  testMarkdownRoundTrip,
  validateEditorUrl,
} from "./LexicalDocumentEditor.js";

describe("Markdown round-trip and compatibility verification", () => {
  it("detects unsupported Markdown tables, raw HTML, and images", () => {
    expect(checkKnownLimitations("# Title\n\n| A | B |\n|---|---|\n| 1 | 2 |")).toContain("tables");
    expect(checkKnownLimitations("# Content\n\n<div class='test'>block</div>")).toContain("HTML");
    expect(checkKnownLimitations("![Diagram](https://example.com/diag.png)")).toContain("images");
    expect(inspectMarkdownCompatibility("# Clean text").isSupported).toBe(true);
  });

  it("enforces maximum 50,000 character budget", () => {
    expect(checkKnownLimitations("a".repeat(50_001))).toContain("50,000");
  });

  it("accurately tests Markdown round-trip conversion", () => {
    const clean = "# Clean Heading\n\nParagraph text.";
    expect(testMarkdownRoundTrip(clean).isLossless).toBe(true);
    const changed = "# Heading\n\nBody text.\n";
    const res = testMarkdownRoundTrip(changed);
    expect(res.isLossless).toBe(false);
    expect(res.converted).toBe("# Heading\n\nBody text.");
  });

  it("safely handles Unicode characters and emojis", () => {
    expect(testMarkdownRoundTrip("# नमस्ते Rellane 🚀 — café & résumé").isLossless).toBe(true);
  });
});

describe("validateEditorUrl", () => {
  it("permits valid http, https, and mailto links", () => {
    expect(validateEditorUrl("https://rellane.local/docs")).toBe(true);
    expect(validateEditorUrl("http://localhost:3000")).toBe(true);
    expect(validateEditorUrl("mailto:team@rellane.local")).toBe(true);
  });

  it("blocks dangerous script and data protocols", () => {
    expect(validateEditorUrl("javascript:alert(1)")).toBe(false);
    expect(validateEditorUrl("data:text/html,bad")).toBe(false);
    expect(validateEditorUrl("vbscript:bad")).toBe(false);
  });
});

describe("LexicalDocumentEditor Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("plain init no callback: guarantees unchanged initialization without invoking onChange", () => {
    const handleChange = vi.fn();
    render(<LexicalDocumentEditor documentKey="doc-init-1" initialMarkdown={"# Clean Document\n\nVerbatim content."} onChange={handleChange} />);
    expect(screen.getByText("Clean Document")).toBeDefined();
    expect(handleChange).not.toHaveBeenCalled();
  });

  it("conversion guard: presents diff view with explicit actions when conversion changes bytes", () => {
    const handleChange = vi.fn();
    const handleRequestSource = vi.fn();
    const markdownWithDiff = "# Heading\n\nBody text.\n";
    const { rerender } = render(
      <LexicalDocumentEditor documentKey="doc-guard-1" initialMarkdown={markdownWithDiff} onChange={handleChange} onRequestSource={handleRequestSource} />
    );
    expect(screen.getByRole("region", { name: "Conversion preview" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Version comparison" })).toBeDefined();
    const keepSourceBtn = screen.getByRole("button", { name: "Keep source editing" });
    expect(handleChange).not.toHaveBeenCalled();
    fireEvent.click(keepSourceBtn);
    expect(handleRequestSource).toHaveBeenCalledTimes(1);

    rerender(<LexicalDocumentEditor documentKey="doc-guard-2" initialMarkdown={markdownWithDiff} onChange={handleChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Use rich editor" }));
    expect(handleChange).toHaveBeenCalledWith(expect.objectContaining({ markdown: "# Heading\n\nBody text." }));
  });

  it("semantic content edits: invokes onChange only when actual editing occurs", async () => {
    const handleChange = vi.fn();
    const editorRef = React.createRef<LexicalEditor | null>();
    render(<LexicalDocumentEditor documentKey="doc-edit-1" initialMarkdown={"# Document Title\n\nInitial paragraph."} onChange={handleChange} editorRef={editorRef as React.MutableRefObject<LexicalEditor | null>} />);
    expect(handleChange).not.toHaveBeenCalled();
    act(() => {
      editorRef.current?.update(() => {
        const root = $getRoot();
        const last = root.getLastChild();
        if ($isElementNode(last)) last.append($createTextNode(" edited"));
      }, { discrete: true });
    });
    await waitFor(() => expect(handleChange).toHaveBeenCalledTimes(1));
    expect(handleChange).toHaveBeenCalledWith(expect.objectContaining({ markdown: expect.stringContaining("edited") }));
  });

  it("runtime readOnly: updates editable state and toolbar controls dynamically after mount", () => {
    const { rerender } = render(<LexicalDocumentEditor documentKey="doc-ro-1" initialMarkdown="# Editable Title" readOnly={false} />);
    const boldBtn = screen.getByRole("button", { name: "Format bold" });
    const editorContent = screen.getByLabelText("Rich text document content");
    expect(boldBtn.hasAttribute("disabled")).toBe(false);
    expect(editorContent.getAttribute("contenteditable")).toBe("true");
    rerender(<LexicalDocumentEditor documentKey="doc-ro-1" initialMarkdown="# Editable Title" readOnly={true} />);
    expect(boldBtn.hasAttribute("disabled")).toBe(true);
    expect(editorContent.getAttribute("contenteditable")).toBe("false");
    expect(editorContent.getAttribute("aria-readonly")).toBe("true");
  });

  it("document reset: preserves user content across identical keys and resets on new key", () => {
    const { rerender } = render(<LexicalDocumentEditor documentKey="doc-reset-1" initialMarkdown="Original document text" />);
    expect(screen.getByText("Original document text")).toBeDefined();
    rerender(<LexicalDocumentEditor documentKey="doc-reset-1" initialMarkdown="New external text" />);
    expect(screen.getByText("Original document text")).toBeDefined();
    expect(screen.queryByText("New external text")).toBeNull();
    rerender(<LexicalDocumentEditor documentKey="doc-reset-2" initialMarkdown="Reset fresh text" />);
    expect(screen.getByText("Reset fresh text")).toBeDefined();
  });

  it("external navigation blocked: intercepts link clicks to prevent network navigation", () => {
    render(<LexicalDocumentEditor documentKey="doc-nav-1" initialMarkdown="Read [Rellane Guides](https://rellane.local/docs) here." />);
    const link = screen.getByText("Rellane Guides");
    expect(link.closest("a")?.getAttribute("href")).toBe("https://rellane.local/docs");
    expect(fireEvent.click(link)).toBe(false);
  });

  it("known unsupported features: preserves source mode with specific limitation and allows plain editing", () => {
    const handleChange = vi.fn();
    const tableMarkdown = "# Table Output\n\n| Item | Count |\n| --- | --- |\n| Test | 10 |";
    render(<LexicalDocumentEditor documentKey="doc-unsupp-1" initialMarkdown={tableMarkdown} onChange={handleChange} />);
    expect(screen.getByText(/tables are not supported/i)).toBeDefined();
    const textarea = screen.getByLabelText("Plain source editor") as HTMLTextAreaElement;
    expect(textarea.value).toBe(tableMarkdown);
    fireEvent.change(textarea, { target: { value: `${tableMarkdown}\n| More | 20 |` } });
    expect(handleChange).toHaveBeenCalledWith(expect.objectContaining({ markdown: `${tableMarkdown}\n| More | 20 |` }));
  });
});
