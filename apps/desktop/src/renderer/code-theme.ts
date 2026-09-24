/**
 * Language aliases and theme extraction for code block highlighting.
 *
 * Models emit varied language fence labels that need normalizing to Shiki grammar
 * identifiers, and dual-theme tokens need splitting into light and dark colours.
 * This module is kept pure and free of Shiki dependencies so it can be evaluated
 * and unit-tested without loading heavy TextMate grammars.
 */

export const MAX_CODE_CHARS = 100_000;
export const MAX_CODE_LINES = 2_000;

/**
 * Maps common model fence labels to their canonical Shiki language identifiers.
 * Grouped to preserve aliases commonly written by models.
 */
export const SUPPORTED_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
  js: "javascript",
  jsx: "jsx",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  py: "python",
  python: "python",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  shell: "bash",
  zsh: "bash",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  css: "css",
  yaml: "yaml",
  yml: "yaml",
  rust: "rust",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  swift: "swift",
  kotlin: "kotlin",
  php: "php",
  ruby: "ruby",
  rb: "ruby",
  toml: "toml",
  xml: "xml",
  diff: "diff",
});

/** Fence label a model wrote -> a shiki language id, or null to render plain. */
export function resolveCodeLanguage(label: string | null | undefined): string | null {
  if (typeof label !== "string") {
    return null;
  }
  const cleaned = label.trim().toLowerCase();
  if (cleaned.length === 0) {
    return null;
  }
  // Safe lookup avoiding prototype pollution or inherited Object properties
  if (!Object.prototype.hasOwnProperty.call(SUPPORTED_ALIASES, cleaned)) {
    return null;
  }
  const resolved = SUPPORTED_ALIASES[cleaned];
  return resolved !== undefined ? resolved : null;
}

/** Splits a shiki token's htmlStyle into the two colours, either of which may be absent. */
export function themeColours(
  htmlStyle: Readonly<Record<string, string>> | undefined
): { readonly light: string | null; readonly dark: string | null } {
  if (!htmlStyle || typeof htmlStyle !== "object") {
    return { light: null, dark: null };
  }
  const light =
    Object.prototype.hasOwnProperty.call(htmlStyle, "color") &&
    typeof htmlStyle["color"] === "string" &&
    htmlStyle["color"].length > 0
      ? htmlStyle["color"]
      : null;
  const dark =
    Object.prototype.hasOwnProperty.call(htmlStyle, "--shiki-dark") &&
    typeof htmlStyle["--shiki-dark"] === "string" &&
    htmlStyle["--shiki-dark"].length > 0
      ? htmlStyle["--shiki-dark"]
      : null;
  return { light, dark };
}
