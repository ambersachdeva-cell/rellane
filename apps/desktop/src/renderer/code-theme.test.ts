import { describe, expect, it } from "vitest";
import {
  MAX_CODE_CHARS,
  MAX_CODE_LINES,
  SUPPORTED_ALIASES,
  resolveCodeLanguage,
  themeColours,
} from "./code-theme.js";

describe("code-theme", () => {
  describe("resolveCodeLanguage", () => {
    it("resolves every documented alias to its canonical language identifier", () => {
      const documentedAliases = [
        "ts",
        "tsx",
        "typescript",
        "js",
        "jsx",
        "javascript",
        "mjs",
        "cjs",
        "json",
        "py",
        "python",
        "sql",
        "sh",
        "bash",
        "shell",
        "zsh",
        "md",
        "markdown",
        "html",
        "css",
        "yaml",
        "yml",
        "rust",
        "rs",
        "go",
        "java",
        "c",
        "cpp",
        "c++",
        "swift",
        "kotlin",
        "php",
        "ruby",
        "rb",
        "toml",
        "xml",
        "diff",
      ] as const;

      for (const alias of documentedAliases) {
        const resolved = resolveCodeLanguage(alias);
        expect(resolved).not.toBeNull();
        expect(resolved).toBe(SUPPORTED_ALIASES[alias]);
      }
    });

    it("normalises case and leading or trailing whitespace", () => {
      expect(resolveCodeLanguage("  TS  ")).toBe("typescript");
      expect(resolveCodeLanguage("TypeScript")).toBe("typescript");
      expect(resolveCodeLanguage("\n  python \t")).toBe("python");
      expect(resolveCodeLanguage("C++")).toBe("cpp");
      expect(resolveCodeLanguage("  RUST ")).toBe("rust");
    });

    it("returns null for unknown, empty, null, and undefined inputs", () => {
      expect(resolveCodeLanguage("unknown")).toBeNull();
      expect(resolveCodeLanguage("fortran")).toBeNull();
      expect(resolveCodeLanguage("")).toBeNull();
      expect(resolveCodeLanguage("   ")).toBeNull();
      expect(resolveCodeLanguage("\t\n")).toBeNull();
      expect(resolveCodeLanguage(null)).toBeNull();
      expect(resolveCodeLanguage(undefined)).toBeNull();
    });

    it("does not match object prototype properties", () => {
      expect(resolveCodeLanguage("toString")).toBeNull();
      expect(resolveCodeLanguage("valueOf")).toBeNull();
      expect(resolveCodeLanguage("constructor")).toBeNull();
      expect(resolveCodeLanguage("__proto__")).toBeNull();
    });

    it("does not throw on arbitrary non-string inputs", () => {
      expect(() => resolveCodeLanguage(null)).not.toThrow();
      expect(() => resolveCodeLanguage(undefined)).not.toThrow();
      expect(() => resolveCodeLanguage("")).not.toThrow();
    });
  });

  describe("themeColours", () => {
    it("extracts both light and dark colours when present", () => {
      const colours = themeColours({
        color: "#D73A49",
        "--shiki-dark": "#F97583",
      });
      expect(colours).toEqual({
        light: "#D73A49",
        dark: "#F97583",
      });
    });

    it("extracts light colour when only color is present", () => {
      const colours = themeColours({ color: "#D73A49" });
      expect(colours).toEqual({
        light: "#D73A49",
        dark: null,
      });
    });

    it("extracts dark colour when only --shiki-dark is present", () => {
      const colours = themeColours({ "--shiki-dark": "#F97583" });
      expect(colours).toEqual({
        light: null,
        dark: "#F97583",
      });
    });

    it("returns nulls for empty object", () => {
      const colours = themeColours({});
      expect(colours).toEqual({
        light: null,
        dark: null,
      });
    });

    it("returns nulls for undefined input", () => {
      const colours = themeColours(undefined);
      expect(colours).toEqual({
        light: null,
        dark: null,
      });
    });

    it("returns nulls for empty colour strings", () => {
      const colours = themeColours({ color: "", "--shiki-dark": "" });
      expect(colours).toEqual({
        light: null,
        dark: null,
      });
    });

    it("does not throw on missing or unexpected input types", () => {
      expect(() => themeColours(undefined)).not.toThrow();
      expect(() => themeColours({})).not.toThrow();
      expect(() => themeColours({ unrelated: "value" })).not.toThrow();
    });
  });

  describe("size limits", () => {
    it("exports sensible guard constants", () => {
      expect(MAX_CODE_CHARS).toBe(100_000);
      expect(MAX_CODE_LINES).toBe(2_000);
    });
  });
});
