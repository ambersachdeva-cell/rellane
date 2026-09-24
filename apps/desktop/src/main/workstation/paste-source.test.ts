import { describe, expect, it } from "vitest";
import { analysePaste, MAX_PASTE_CHARS } from "./paste-source.js";

describe("analysePaste", () => {
  it("detects a single URL and extracts host and path title", () => {
    const text = "https://github.com/google/gemini";
    const result = analysePaste(text);
    expect(result.kind).toBe("url");
    expect(result.host).toBe("github.com");
    expect(result.title).toBe("/google/gemini");
    expect(result.language).toBeNull();
  });

  it("detects formatted JSON and extracts top-level key as title", () => {
    const text = '{\n  "service": "billing",\n  "port": 8080\n}';
    const result = analysePaste(text);
    expect(result.kind).toBe("json");
    expect(result.title).toBe("service");
    expect(result.host).toBeNull();
    expect(result.language).toBeNull();
  });

  it("detects CSV data and derives title from the first header", () => {
    const text = "name,age,role\nAlice,30,Engineer\nBob,25,Designer";
    const result = analysePaste(text);
    expect(result.kind).toBe("csv");
    expect(result.title).toBe("name");
    expect(result.host).toBeNull();
    expect(result.language).toBeNull();
  });

  it("detects code and identifies language and opening line", () => {
    const text = "function calculateTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}";
    const result = analysePaste(text);
    expect(result.kind).toBe("code");
    expect(result.language).toBe("typescript");
    expect(result.title).toBe("function calculateTotal(items: number[]): number {");
    expect(result.host).toBeNull();
  });

  it("detects markdown and derives title from a heading", () => {
    const text = "# Project Roadmap\n\n- Milestone 1\n- Milestone 2";
    const result = analysePaste(text);
    expect(result.kind).toBe("markdown");
    expect(result.title).toBe("Project Roadmap");
    expect(result.language).toBeNull();
    expect(result.host).toBeNull();
  });

  it("detects image data URLs with mime-derived title", () => {
    const text = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const result = analysePaste(text);
    expect(result.kind).toBe("image");
    expect(result.title).toBe("PNG image");
    expect(result.host).toBeNull();
    expect(result.language).toBeNull();
  });

  it("detects plain text and derives title from first meaningful line", () => {
    const text = "Spoke with the team about project deadlines.\nWe will reconvene on Friday morning.";
    const result = analysePaste(text);
    expect(result.kind).toBe("text");
    expect(result.title).toBe("Spoke with the team about project deadlines.");
    expect(result.language).toBeNull();
    expect(result.host).toBeNull();
  });

  it("derives title from a quoted CSV header", () => {
    const text = '"Customer Account",Balance,Status\nAcme Corp,15000,Active\nBeta Ltd,4200,Pending';
    const result = analysePaste(text);
    expect(result.kind).toBe("csv");
    expect(result.title).toBe("Customer Account");
  });

  it("warns when content contains a bearer token", () => {
    const text = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token.signature";
    const result = analysePaste(text);
    expect(result.warnings.some(w => w.includes("API token") || w.includes("secret"))).toBe(true);
  });

  it("warns when content contains bidirectional control characters", () => {
    const text = 'const filename = "user_\u202Efdp.exe";';
    const result = analysePaste(text);
    expect(result.warnings.some(w => w.includes("bidirectional") || w.includes("invisible"))).toBe(true);
  });

  it("warns on an unusually long single line", () => {
    const text = "const a=" + "1+".repeat(500) + "0;";
    const result = analysePaste(text);
    expect(result.warnings.some(w => w.includes("unusually long") || w.includes("minified"))).toBe(true);
  });

  it("never alters the analysed input string", () => {
    const text = "  Whitespace-sensitive content\nwith multiple lines  ";
    const copy = text;
    const result = analysePaste(text);
    expect(text).toBe(copy);
    expect(result.preview).toBe(text);
    expect(result.chars).toBe(text.length);
  });

  it("warns when input exceeds MAX_PASTE_CHARS without trimming", () => {
    const text = "a".repeat(MAX_PASTE_CHARS + 10);
    const result = analysePaste(text);
    expect(result.chars).toBe(MAX_PASTE_CHARS + 10);
    expect(result.warnings.some(w => w.includes("500,000"))).toBe(true);
  });
});
